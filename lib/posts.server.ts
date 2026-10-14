// lib/posts.server.ts — 供客户端组件引用的轻量包装
// (把纯数据函数抽离,避免客户端 bundle 意外带上 fs)
import { getAllPosts, getCategories, getTagMap } from "./posts";

export { getAllPosts, getCategories, getTagMap };
