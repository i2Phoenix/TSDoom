# 🔥 TSDoom

🌐 _[English](../README.md) | [Русский](README.ru.md) | 中文 | [日本語](README.ja.md) | [Español](README.es.md)_

从零开始用 **TypeScript** 编写的 DOOM 引擎，通过 HTML5 `<canvas>` 在浏览器中运行。没有 WebGL，没有框架——就像 1993 年一样的纯软件渲染。

TSDoom 加载原版 **DOOM1.WAD**，忠实地重现了经典的 id Tech 1 引擎：BSP 渲染、扇区光照、动画纹理、即时命中武器、门、升降梯、压碎机、物品拾取等等。

## 🚀 快速开始

### 前置条件

- [Node.js](https://nodejs.org/)（v18+）
- 一份 `DOOM1.WAD` 文件（原版 DOOM 的共享软件 WAD）

### 安装

```bash
# 克隆仓库
git clone https://github.com/your-username/TSDoom.git
cd TSDoom

# 安装依赖
npm install

# 放置 WAD 文件
# 将 DOOM1.WAD 复制到 data/ 目录
cp /path/to/DOOM1.WAD data/

# 启动开发服务器
npm run dev
```

在浏览器中打开 [http://localhost:5173](http://localhost:5173) 即可开始游戏。

### 生产环境构建

```bash
npm run build
npm run preview
```

## 🎮 操作方式

| 操作      | 按键           |
| --------- | -------------- |
| 前进      | `W`            |
| 后退      | `S`            |
| 左平移    | `A`            |
| 右平移    | `D`            |
| 转向/瞄准 | 鼠标           |
| 射击      | 鼠标左键       |
| 使用/开门 | `E` 或 `Space` |
| 奔跑      | `Shift`        |
| 切换武器  | `1`–`7`        |
| 菜单/暂停 | `Escape`       |
| 帮助      | `F1`           |

> 点击画布以捕获鼠标指针（指针锁定）。

## 🔧 技术栈

| 组件     | 技术                          |
| -------- | ----------------------------- |
| 语言     | TypeScript                    |
| 构建工具 | Vite                          |
| 渲染     | HTML5 Canvas 2D（软件渲染器） |
| 目标标准 | ES2024                        |

**零运行时依赖。** 整个引擎完全从零构建，仅使用 TypeScript 和 Vite 作为开发依赖。

## 📖 参考资料

引擎实现紧密参照了原版 DOOM 源代码：

- [id Software DOOM 源代码](https://github.com/id-Software/DOOM) — 原始 C 语言代码库
- [Unofficial DOOM Specs](https://doomwiki.org/wiki/Unofficial_Doom_Specs) — WAD 格式和数据结构
- [DOOM Wiki](https://doomwiki.org/) — 全面的 DOOM 百科参考
- [Game Engine Black Book: DOOM（Fabien Sanglard）](https://fabiensanglard.net/gebbdoom/) — 详细的引擎分析

## ⚖️ 法律声明

DOOM 是 id Software / ZeniMax Media / Microsoft 的注册商标。本项目是独立的教育性引擎重新实现，**不**包含任何受版权保护的游戏数据。您必须自行提供 `DOOM1.WAD` 文件。

## 📄 许可证

本项目仅供教育目的，按原样提供。
