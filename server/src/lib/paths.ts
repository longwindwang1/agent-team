import path from 'node:path'
import { fileURLToPath } from 'node:url'

// 仓库根路径常量：从 db/index.ts 迁出，切断「引常量就得拉起数据库」的导入依赖。
// 目录创建（mkdirSync）发生在 initDb()，不在模块求值期。
const here = path.dirname(fileURLToPath(import.meta.url))
export const ROOT_DIR = path.resolve(here, '../../..')
export const DATA_DIR = path.join(ROOT_DIR, 'data')
export const WORKSPACES_DIR = path.join(ROOT_DIR, 'workspaces')
