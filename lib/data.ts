// lib/data.ts — 读取 data/*.json(后台可编辑)
import fs from "fs";
import path from "path";

export interface Friend {
  name: string;
  url: string;
  avatar: string;
  description: string;
}

export interface Project {
  name: string;
  description: string;
  stack: string[];
  link: string;
  repo?: string;
  emoji: string;
}

export interface Photo {
  src: string;
  caption?: string;
}

export interface Album {
  id: string;
  title: string;
  description: string;
  cover: string;
  photos: Photo[];
}

function readJson<T>(name: string, key: string, fallback: T): T {
  try {
    const abs = path.join(process.cwd(), "data", `${name}.json`);
    if (!fs.existsSync(abs)) return fallback;
    const parsed = JSON.parse(fs.readFileSync(abs, "utf8")) as Record<string, unknown>;
    return (parsed[key] as T) ?? fallback;
  } catch {
    return fallback;
  }
}

export function getFriends(): Friend[] {
  return readJson<Friend[]>("friends", "friends", []);
}

export function getProjects(): Project[] {
  return readJson<Project[]>("projects", "projects", []);
}

export function getAlbums(): Album[] {
  return readJson<Album[]>("albums", "albums", []);
}

export function getAlbum(id: string): Album | undefined {
  return getAlbums().find((a) => a.id === id);
}
