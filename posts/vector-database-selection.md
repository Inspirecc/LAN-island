---
title: 向量数据库选型：Milvus、Qdrant 与 pgvector
date: 2026-08-12
description: 向量检索是 RAG 的地基，但选型不只是比性能。数据量级、是否需要混合检索、运维成本、能否复用现有数据库，这四个问题决定了答案。
tags: [向量数据库, RAG, Milvus, 技术选型]
category: AI 与大模型
---

## 一、先明确:向量检索到底在做什么

RAG 的核心动作是"给一个问题,找出最相关的几段资料"。传统数据库靠精确匹配,而语义相似度没法用 `WHERE` 表达——"保修多久"和"质保期多长"字面上没有任何共同词,但语义几乎相同。

向量检索的思路是:

```
文本 ──embedding 模型──→ 高维向量 [0.12, -0.83, 0.45, ...]

"保修多久"    → [0.12, -0.83, 0.45, ...]
"质保期多长"  → [0.13, -0.81, 0.47, ...]   ← 向量距离很近
"如何退货"    → [-0.77, 0.21, -0.09, ...]  ← 向量距离远
```

检索就是**在高维空间里找距离最近的向量**。

这件事传统数据库做不了,所以有了向量数据库。但如果只是"存向量 + 找近邻",用现有的数据库加个扩展也能做——这就是选型的第一个分岔口。

## 二、四个决定性的问题

选型之前,先回答这四个问题:

| # | 问题 | 影响 |
|---|---|---|
| 1 | 数据量级是多少?(万 / 百万 / 亿) | 决定能否用轻量方案 |
| 2 | 需要混合检索吗?(向量 + 关键词 + 标量过滤) | 决定功能要求 |
| 3 | 团队能维护几个中间件? | 决定运维成本可接受度 |
| 4 | 是否已有 PostgreSQL / ES? | 决定能否复用 |

**第 4 个问题最容易被忽略,但往往最有价值**:如果团队已经在用 PostgreSQL,那么 `pgvector` 可能就是最优解——不是因为它在技术上最强,而是因为**不引入新的运维负担**。

## 三、主流方案对比

| 方案 | 类型 | 适合量级 | 混合检索 | 运维成本 |
|---|---|---|---|---|
| **pgvector** | PostgreSQL 扩展 | 十万~百万 | 强(能用 SQL 组合) | 极低(复用 PG) |
| **Milvus** | 专业向量库 | 百万~百亿 | 强(2.5+ 原生 BM25) | 高(组件多) |
| **Qdrant** | 专业向量库 | 十万~亿 | 强(原生混合) | 中(单二进制) |
| **Elasticsearch** | 搜索引擎 | 十万~千万 | 很强(BM25 + kNN) | 中(团队可能已有) |
| **Redis** | 内存数据库 | 百万以内 | 弱 | 低(但内存成本高) |
| **FAISS** | 库(非数据库) | 取决于内存 | 无 | 极低(但要自己实现增删改) |

### pgvector:够用且省事

```sql
CREATE EXTENSION vector;

CREATE TABLE kb_chunk (
    id        BIGSERIAL PRIMARY KEY,
    doc_id    BIGINT,
    content   TEXT,
    embedding vector(1536),          -- 维度要和 embedding 模型一致
    metadata  JSONB
);

-- HNSW 索引:比 IVFFlat 更准,但构建慢、占空间
CREATE INDEX ON kb_chunk USING hnsw (embedding vector_cosine_ops);

-- 检索:向量相似度 + 标量过滤,一条 SQL 搞定
SELECT content, 1 - (embedding <=> $1) AS score
FROM kb_chunk
WHERE metadata->>'doc_type' = 'manual'     -- 元数据过滤
ORDER BY embedding <=> $1
LIMIT 5;
```

**优势**:

- **零新增中间件**——复用现有 PG 的备份、监控、权限、连接池
- **事务性**——向量和业务数据在同一个事务里,不用担心一致性
- **元数据过滤天然强大**——就是 SQL,想怎么组合都行
- 团队已有的 PG 运维经验直接复用

**劣势**:

- 数据量上到千万级后,性能开始明显下降
- HNSW 索引占内存,大表需要仔细调参
- 高并发检索会和其他业务查询争资源

**适用判断**:数据量在百万以内、团队已在用 PG、想做元数据过滤——**pgvector 通常是最省心的选择**。

### Milvus:为向量而生

```python
from pymilvus import Collection, FieldSchema, CollectionSchema, DataType

fields = [
    FieldSchema("id", DataType.INT64, is_primary=True),
    FieldSchema("content", DataType.VARCHAR, max_length=8192),
    FieldSchema("embedding", DataType.FLOAT_VECTOR, dim=1536),
]
schema = CollectionSchema(fields)
collection = Collection("kb_chunk", schema)

collection.create_index("embedding", {
    "index_type": "HNSW",
    "metric_type": "COSINE",
    "params": {"M": 16, "efConstruction": 200}
})
collection.load()

results = collection.search(
    data=[query_vector], anns_field="embedding",
    param={"metric_type": "COSINE", "params": {"ef": 64}},
    limit=5
)
```

**优势**:

- **为海量向量设计**,支持分布式、水平扩展
- 多种索引类型可选(IVF、HNSW、DiskANN 等)
- 2.5+ 版本**原生支持 BM25 稀疏向量**,混合检索不用外挂
- 社区活跃,生态完善

**劣势**:

- **架构复杂**:依赖 etcd、对象存储、消息队列,部署和运维成本高
- **小数据量下是杀鸡用牛刀**——几万条数据用 Milvus,复杂度完全不划算
- 资源占用大

**适用判断**:数据量到千万级以上、需要分布式、团队有中间件运维能力。

### Qdrant:复杂度与能力的平衡点

```python
from qdrant_client import QdrantClient
from qdrant_client.models import Distance, VectorParams, PointStruct

client = QdrantClient(url="http://localhost:6333")
client.create_collection(
    collection_name="kb_chunk",
    vectors_config=VectorParams(size=1536, distance=Distance.COSINE),
)

client.upsert("kb_chunk", points=[
    PointStruct(id=1, vector=vec, payload={"doc_type": "manual", "content": "..."})
])

hits = client.search(
    collection_name="kb_chunk",
    query_vector=query_vec,
    query_filter={"must": [{"key": "doc_type", "match": {"value": "manual"}}]},
    limit=5,
)
```

**优势**:

- **单二进制部署**,比 Milvus 轻量得多
- 原生支持**向量 + payload 过滤**,过滤性能好
- 支持稀疏向量,可做混合检索
- Rust 实现,性能不错

**适用判断**:想要专业向量库的能力,但不想承担 Milvus 的运维复杂度。

### Elasticsearch:已有 ES 时的自然选择

如果团队已经在用 ES 做搜索,那么**直接加一个 `dense_vector` 字段**往往比引入新中间件更合理:

```json
PUT /kb_chunk
{
  "mappings": {
    "properties": {
      "content":   { "type": "text", "analyzer": "ik_max_word" },
      "embedding": {
        "type": "dense_vector",
        "dims": 1536,
        "index": true,
        "similarity": "cosine"
      },
      "doc_type":  { "type": "keyword" }
    }
  }
}
```

```json
POST /kb_chunk/_search
{
  "knn": {
    "field": "embedding",
    "query_vector": [0.12, -0.83, ...],
    "k": 10,
    "num_candidates": 100,
    "filter": { "term": { "doc_type": "manual" } }
  },
  "query": {
    "match": { "content": "保修期" }        // 关键词检索,可与 kNN 混合
  }
}
```

**优势**:

- **混合检索天然强大**:BM25 关键词检索 + kNN 向量检索,加上成熟的聚合、排序能力
- 团队往往已有 ES 运维经验
- 元数据过滤、聚合统计都是成熟能力

**劣势**:

- 向量检索性能不如专业向量库
- 内存占用较高(dense_vector 默认全部加载)
- 数据量上亿后吃力

**适用判断**:已用 ES、需要强混合检索、数据量在千万以内。

## 四、关键能力:混合检索

纯向量检索有个已知短板:**对专有名词、编号、精确匹配不敏感**。

```
查询:"H20 的滤网型号"
```

向量模型可能把"H20"和"H20 Pro""H200"混在一起,因为它们语义上很接近。但如果用关键词检索,型号能精确命中。

**所以生产环境几乎都用混合检索**:

```
              ┌─→ 向量检索(语义相似)  ─┐
用户查询 ─────┤                        ├─→ RRF 融合 → Rerank → Top-N
              └─→ 关键词检索(BM25)    ─┘
```

| 检索方式 | 擅长 | 短板 |
|---|---|---|
| **向量检索** | 语义相近、同义表达 | 专有名词、编号、精确词 |
| **关键词检索(BM25)** | 精确词、术语、编号 | 同义改写、语义相近 |

**两者互补**,融合后召回质量明显优于任一单独方案。

**这直接影响选型**:

| 方案 | 混合检索实现难度 |
|---|---|
| Elasticsearch | ⭐ 最简单(同一引擎内) |
| Milvus 2.5+ | ⭐⭐ 原生 BM25 function |
| Qdrant | ⭐⭐ 原生稀疏向量 |
| pgvector | ⭐⭐⭐ 需要自己接全文检索(`tsvector` + RRF 融合) |
| Redis / FAISS | ⭐⭐⭐⭐ 基本要自己搭 |

**如果混合检索是硬需求**,ES 或 Milvus 2.5+ 会更省事。

## 五、索引类型怎么选

向量索引的核心是**在"检索速度"和"召回精度"之间取舍**——为了快,就得牺牲一点准确性(近似最近邻,ANN)。

| 索引 | 原理 | 特点 | 适用 |
|---|---|---|---|
| **Flat** | 暴力计算全部距离 | 100% 精确,最慢 | 小数据量(< 10 万) |
| **IVF** | 先聚类,只搜最近的几个簇 | 快,精度取决于 `nprobe` | 大数据量,内存有限 |
| **HNSW** | 多层图,逐层逼近 | **精度和速度都好**,但占内存 | 主流选择 |
| **DiskANN** | 图索引存在磁盘 | 省内存,略慢 | 超大规模 |

**HNSW 是当前的主流默认选择**,两个关键参数:

| 参数 | 作用 | 调大后 |
|---|---|---|
| `M` | 每个节点的连接数 | 精度↑、内存↑、构建慢 |
| `efConstruction` | 构建时的搜索宽度 | 索引质量↑、构建慢 |
| `ef`(查询时) | 查询时的搜索宽度 | 精度↑、查询慢 |

**`ef` 是唯一可以在查询时调的参数**——这意味着可以**按场景调整精度**:关键场景调大 `ef` 保精度,一般场景调小求速度。

## 六、选型决策树

```
数据量 < 100 万?
├─ 是 → 已在用 PG?
│        ├─ 是 → pgvector          ← 最省心
│        └─ 否 → 已在用 ES?
│                 ├─ 是 → ES dense_vector
│                 └─ 否 → Qdrant(轻量专业)
└─ 否 → 数据量 > 5000 万?
         ├─ 是 → Milvus(分布式)
         └─ 否 → 需要强混合检索?
                  ├─ 是 → ES 或 Milvus 2.5+
                  └─ 否 → Qdrant / Milvus
```

## 小结

- 选型先问四个问题:**数据量级**、**是否需要混合检索**、**运维能力**、**能否复用现有数据库**
- **"能复用现有中间件"往往比"技术指标最强"更有价值**——pgvector 和 ES 常常因此胜出
- **pgvector**:百万以内、已用 PG 时的最省心选择,元数据过滤就是 SQL
- **Milvus**:千万级以上、需要分布式的场景,但架构复杂、运维成本高
- **Qdrant**:单二进制部署,复杂度与能力的平衡点
- **Elasticsearch**:已用 ES 时的自然选择,混合检索最强
- **混合检索几乎是生产必备**:向量擅长语义,BM25 擅长精确词,两者互补
- 索引选 **HNSW** 为主;`ef` 可在查询时调,实现**按场景调整精度**
- 小数据量用 Milvus 是**杀鸡用牛刀**——复杂度不划算

向量数据库的选型,技术指标只是其中一维。**引入一个新中间件意味着长期的运维投入**,而"用已有的东西解决问题"通常更符合工程直觉。
