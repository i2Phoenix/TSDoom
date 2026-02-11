![TSDoom](docs/tsdoom.png)

# 🔥 TSDoom

🌐 _English | [Русский](docs/README.ru.md) | [中文](docs/README.zh.md) | [日本語](docs/README.ja.md) | [Español](docs/README.es.md)_

A from-scratch DOOM engine written entirely in **TypeScript**, running in the browser via an HTML5 `<canvas>`. No WebGL, no frameworks — just raw software rendering like it's 1993.

TSDoom loads the original **DOOM1.WAD** and faithfully recreates the classic id Tech 1 engine: BSP rendering, sector-based lighting, animated textures, hitscan weapons, doors, lifts, crushers, item pickups, and more.

## 🚀 Getting Started

### Prerequisites

- [Node.js](https://nodejs.org/) (v18+)
- A copy of `DOOM1.WAD` (the shareware WAD from the original DOOM)

### Setup

```bash
# Clone the repository
git clone https://github.com/your-username/TSDoom.git
cd TSDoom

# Install dependencies
npm install

# Place the WAD file
# Copy DOOM1.WAD into the data/ directory
cp /path/to/DOOM1.WAD data/

# Start the dev server
npm run dev
```

Open [http://localhost:5173](http://localhost:5173) in your browser and play.

### Build for Production

```bash
npm run build
npm run preview
```

## 🎮 Controls

| Action        | Key               |
| ------------- | ----------------- |
| Move forward  | `W`               |
| Move backward | `S`               |
| Strafe left   | `A`               |
| Strafe right  | `D`               |
| Turn / Aim    | Mouse             |
| Fire          | Left Mouse Button |
| Use / Open    | `E` or `Space`    |
| Run           | `Shift`           |
| Weapon select | `1`–`7`           |
| Menu / Pause  | `Escape`          |
| Help          | `F1`              |

> Click the canvas to capture the mouse pointer (pointer lock).

## 🔧 Tech Stack

| Component | Technology                          |
| --------- | ----------------------------------- |
| Language  | TypeScript                          |
| Bundler   | Vite                                |
| Rendering | HTML5 Canvas 2D (software renderer) |
| Target    | ES2024                              |

**Zero runtime dependencies.** The entire engine is built from scratch with only TypeScript and Vite as dev dependencies.

## 📖 References

The engine implementation closely follows the original DOOM source code:

- [id Software DOOM source](https://github.com/id-Software/DOOM) — the original C codebase
- [Unofficial DOOM Specs](https://doomwiki.org/wiki/Unofficial_Doom_Specs) — WAD format and data structures
- [DOOM Wiki](https://doomwiki.org/) — comprehensive reference for all things DOOM
- [Fabien Sanglard's Game Engine Black Book: DOOM](https://fabiensanglard.net/gebbdoom/) — detailed engine analysis

## ⚖️ Legal

DOOM is a registered trademark of id Software / ZeniMax Media / Microsoft. This project is an independent, educational reimplementation of the engine and does **not** include any copyrighted game data. You must supply your own `DOOM1.WAD` file.

## 📄 License

This project is provided as-is for educational purposes.
