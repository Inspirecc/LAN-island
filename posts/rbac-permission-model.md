---
title: RBAC 权限模型：表结构设计与落地方案
date: 2026-03-07
description: RBAC 的核心思想是用角色做中转，不给用户直接分配权限。这篇文章拆解标准五张表的职责划分、多对多中间表的必要性，以及数据权限这类扩展场景怎么设计。
tags: [RBAC, 权限设计, 数据库, 后端设计]
category: 数据库
---

## 一、最朴素的做法,以及它为什么撑不住

权限控制的起点通常是这样的:

```sql
CREATE TABLE sys_user (
    id BIGINT PRIMARY KEY,
    username VARCHAR(50),
    permissions VARCHAR(500)   -- "user:list,user:add,order:view"
);
```

用户的权限用逗号分隔存在一个字段里。这个设计在只有三五个用户、权限几乎不变时能跑,但很快会遇到问题:

| 问题 | 具体表现 |
|---|---|
| **查询困难** | 想查"谁有 `user:add` 权限",只能 `LIKE '%user:add%'`,无法走索引 |
| **改权限麻烦** | 加一个权限要遍历所有用户,拼接字符串 |
| **无法复用** | 10 个运营的权限完全相同,却要重复维护 10 份 |
| **容易出错** | 手写字符串,拼错一个字符就是个隐蔽的权限 bug |
| **没有审计** | 谁在什么时候被授予了什么权限,完全无记录 |

**根子在于:它把"权限集合"当成了一个字符串,而不是一组关系。**

## 二、RBAC 的核心思想

**RBAC(Role-Based Access Control,基于角色的访问控制)** 的思路是:**不给用户直接分配权限,通过角色做中转。**

```
用户 ──→ 角色 ──→ 权限
```

为什么加这一层中转这么重要?

| 不用角色 | 用角色 |
|---|---|
| 用户 ↔ 权限 直接多对多 | 用户 → 角色 → 权限 |
| 100 个用户 × 每个 20 条权限 = 2000 条关系 | 100 个用户 × 3 个角色 + 3 个角色 × 20 条权限 = 360 条关系 |
| 调整一类人的权限,要改 N 个用户 | **只改角色,一次生效** |

**角色是对"权限集合"的命名。** 有了名字,权限管理就从"N 个用户的批量操作"变成了"改一个角色"。

## 三、五张核心表

标准 RBAC 由五张表构成,分三组:

### 第 1 组:两个实体表

**用户表 `sys_user`** — 存用户基础信息

```sql
CREATE TABLE sys_user (
    id          BIGINT PRIMARY KEY AUTO_INCREMENT,
    username    VARCHAR(50)  NOT NULL COMMENT '登录名',
    password    VARCHAR(100) NOT NULL COMMENT '加密后的密码',
    nickname    VARCHAR(50)  COMMENT '昵称',
    phone       VARCHAR(20)  COMMENT '手机号',
    status      TINYINT      DEFAULT 1 COMMENT '1启用 0禁用',
    created_at  DATETIME     DEFAULT CURRENT_TIMESTAMP,
    updated_at  DATETIME     DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    is_deleted  TINYINT      DEFAULT 0 COMMENT '软删除标记',
    UNIQUE KEY uk_username (username)
);
```

**角色表 `sys_role`** — 定义有哪些角色

```sql
CREATE TABLE sys_role (
    id          BIGINT PRIMARY KEY AUTO_INCREMENT,
    role_name   VARCHAR(50)  NOT NULL COMMENT '角色名称,如"运营专员"',
    role_code   VARCHAR(50)  NOT NULL COMMENT '角色编码,如 ROLE_OPERATOR',
    description VARCHAR(200) COMMENT '描述',
    status      TINYINT      DEFAULT 1,
    created_at  DATETIME     DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uk_role_code (role_code)
);
```

`role_code` 是程序里判断用的稳定标识,`role_name` 是给人看的显示名。**不要把显示名当标识用**——哪天产品说"运营专员"改叫"运营经理",所有硬编码了中文名的判断都会崩。

### 第 2 组:权限表(菜单/资源)

**菜单权限表 `sys_menu`** — 存所有可授权的资源

```sql
CREATE TABLE sys_menu (
    id          BIGINT PRIMARY KEY AUTO_INCREMENT,
    parent_id   BIGINT       DEFAULT 0 COMMENT '父级 ID,0 为顶级',
    menu_name   VARCHAR(50)  NOT NULL COMMENT '显示名称',
    perms       VARCHAR(100) COMMENT '权限标识,如 sys:user:list',
    path        VARCHAR(200) COMMENT '前端路由地址',
    component   VARCHAR(200) COMMENT '前端组件路径',
    menu_type   TINYINT      NOT NULL COMMENT '1目录 2菜单 3按钮',
    icon        VARCHAR(50)  COMMENT '图标',
    order_num   INT          DEFAULT 0 COMMENT '排序',
    visible     TINYINT      DEFAULT 1 COMMENT '是否显示',
    created_at  DATETIME     DEFAULT CURRENT_TIMESTAMP
);
```

这张表同时承载三件事,靠 `menu_type` 区分:

| menu_type | 含义 | 有没有 `perms` |
|---|---|---|
| 1 目录 | 侧边栏的一级分组,如"系统管理" | 通常没有 |
| 2 菜单 | 一个具体页面,如"用户管理" | 常有,如 `sys:user:list` |
| 3 按钮 | 页面上的操作按钮,如"新增" | 必有,如 `sys:user:add` |

**按钮级权限是 RBAC 落地的关键细节**。只控制到"能不能进这个页面"是不够的——同一个人可能要能看不能改。前端按 `perms` 决定按钮显隐,后端按 `perms` 拦截接口,两边都要校验。

> ⚠️ **前端隐藏按钮只是体验优化,不是安全措施。** 用户完全可以绕过前端直接调接口,所以**权限校验必须落在后端**。

### 第 3 组:两张多对多中间表

**用户角色关联表 `sys_user_role`**

```sql
CREATE TABLE sys_user_role (
    id      BIGINT PRIMARY KEY AUTO_INCREMENT,
    user_id BIGINT NOT NULL,
    role_id BIGINT NOT NULL,
    UNIQUE KEY uk_user_role (user_id, role_id),
    KEY idx_user (user_id)
);
```

**角色菜单关联表 `sys_role_menu`**

```sql
CREATE TABLE sys_role_menu (
    id      BIGINT PRIMARY KEY AUTO_INCREMENT,
    role_id BIGINT NOT NULL,
    menu_id BIGINT NOT NULL,
    UNIQUE KEY uk_role_menu (role_id, menu_id),
    KEY idx_role (role_id)
);
```

一个用户可以多个角色,一个角色可以分配给多个用户——**多对多关系必须用中间表,绝不能把 ID 列表塞进逗号分隔的字段**。

那个联合唯一索引 `uk_user_role` 很关键:它保证同一个人不会被重复授予同一个角色,从数据库层面杜绝脏数据。

## 四、完整的表关系

```
sys_user ──┐
           ├─→ sys_user_role ←─┐
           │                    │
           │              sys_role ──┐
           │                          ├─→ sys_role_menu ←─┐
           │                          │                   │
           │                          │            sys_menu
           │
      (用户信息)                  (角色定义)          (权限资源)
```

**查某个人有哪些权限**,需要三张表 JOIN:

```sql
SELECT DISTINCT m.perms
FROM sys_user_role ur
JOIN sys_role_menu rm ON ur.role_id = rm.role_id
JOIN sys_menu m       ON rm.menu_id = m.id
WHERE ur.user_id = #{userId}
  AND m.perms IS NOT NULL
  AND m.perms != '';
```

这条 SQL 会返回类似 `sys:user:list`、`sys:user:add`、`sys:order:view` 的权限标识集合。

### 权限集合应该缓存

这条三表 JOIN 每个请求都跑一次并不划算。常见做法是**登录时查一次,把权限集合放进 Redis**:

```
key   = perms:user:{userId}
value = ["sys:user:list", "sys:user:add", ...]
TTL   = 30 分钟
```

**关键是失效策略**:管理员改了角色的权限,必须删掉所有相关用户的缓存 key,否则权限变更要等 TTL 过期才生效。简单做法是**在角色权限变更时,删除该角色下所有用户的缓存**。

## 五、扩展:数据权限

基础 RBAC 只回答"能不能操作这个功能"(功能权限),但真实业务还需要回答"**能操作哪些数据**"(数据权限)。

比如:同样是"查看订单"这个功能,华东区经理应该只能看华东的订单,而总部管理员能看全部。这在功能权限层面是完全一样的——都能调 `order:list` 接口。

### 扩展表设计

**部门表 `sys_dept`**

```sql
CREATE TABLE sys_dept (
    id        BIGINT PRIMARY KEY AUTO_INCREMENT,
    parent_id BIGINT DEFAULT 0,
    dept_name VARCHAR(50),
    order_num INT DEFAULT 0,
    leader    VARCHAR(50)
);
```

**角色部门关联表 `sys_role_dept`**

```sql
CREATE TABLE sys_role_dept (
    id      BIGINT PRIMARY KEY AUTO_INCREMENT,
    role_id BIGINT NOT NULL,
    dept_id BIGINT NOT NULL
);
```

用户所属部门挂在 `sys_user.dept_id` 上,角色能看哪些部门挂在 `sys_role_dept` 上。

### 数据权限的四种范围

| 范围 | 含义 | SQL 追加条件 |
|---|---|---|
| 全部 | 不加限制 | 无 |
| 自定义 | 看指定的几个部门 | `dept_id IN (select dept_id from sys_role_dept where role_id=?)` |
| 本部门 | 只看自己部门 | `dept_id = (select dept_id from sys_user where id=?)` |
| 本部门及以下 | 含子部门 | `dept_id IN (子部门递归查询)` |
| 仅本人 | 只看自己的数据 | `create_by = #{userId}` |

**实现方式**通常是 AOP 切面 + MyBatis 拦截器:在 SQL 执行前自动追加 `WHERE` 条件。这样业务代码里不用手写这些条件,避免遗漏。

> **注意**:数据权限比功能权限危险得多。功能权限漏了最多是"多显示一个按钮",数据权限漏了就是**越权看到别人的数据**。上线前一定要专门测。

## 六、几个容易踩的坑

| 坑 | 说明 |
|---|---|
| **权限标识命名混乱** | 统一用 `模块:资源:操作` 三段式(`sys:user:add`),不要一会儿 `addUser` 一会儿 `user_add` |
| **超级管理员硬编码** | 通常给 `admin` 用户一个跳过校验的白名单,但**不要用 `if (username.equals("admin"))` 散落在各处**,应该收敛到一处 |
| **删角色不清理关联** | 删除角色时要同时清理 `sys_user_role` 和 `sys_role_menu`,否则留下孤儿数据 |
| **只做前端校验** | 前端隐藏按钮是体验,后端拦截才是安全 |
| **权限改动不刷缓存** | 权限缓存必须主动失效,不能只靠 TTL |
| **菜单树没有排序** | `order_num` 看着不重要,但没有它前端菜单顺序会随机 |

## 小结

- RBAC 核心:**用户 → 角色 → 权限**,不给用户直接分配权限
- 角色的价值是**给权限集合起个名字**,让 N 个用户的批量操作变成改一个角色
- 五张核心表:`sys_user`、`sys_role`、`sys_menu` + 两张多对多中间表 `sys_user_role`、`sys_role_menu`
- 中间表**必须加联合唯一索引**,防止重复授权
- `menu_type` 区分目录/菜单/按钮,**按钮级权限是落地的关键**
- **前端隐藏按钮不是安全措施,校验必须在后端**
- 权限集合三表 JOIN 结果要**缓存到 Redis**,并在权限变更时主动失效
- 扩展的数据权限(`sys_dept` + `sys_role_dept`)控制"能看哪些数据",比功能权限**危险得多**,要专门测试
- 常见坑:命名混乱、admin 硬编码、删角色不清理关联、只做前端校验

权限设计看起来就是几张表的增删改查,但它是系统的安全边界。**表结构设计得清楚,后面加权限、查问题都会轻松很多。**
