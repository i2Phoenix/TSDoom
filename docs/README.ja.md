# 🔥 TSDoom

🌐 _[English](../README.md) | [Русский](README.ru.md) | [中文](README.zh.md) | 日本語 | [Español](README.es.md)_

**TypeScript** でフルスクラッチで書かれた DOOM エンジン。HTML5 `<canvas>` を使用してブラウザ上で動作します。WebGL なし、フレームワークなし——1993年のようなピュアソフトウェアレンダリング。

TSDoom はオリジナルの **DOOM1.WAD** を読み込み、クラシックな id Tech 1 エンジンを忠実に再現します：BSP レンダリング、セクターベースのライティング、アニメーションテクスチャ、ヒットスキャン武器、ドア、リフト、クラッシャー、アイテムピックアップなど。

## 🚀 はじめに

### 前提条件

- [Node.js](https://nodejs.org/)（v18以上）
- `DOOM1.WAD` のコピー（オリジナル DOOM のシェアウェア WAD）

### セットアップ

```bash
# リポジトリをクローン
git clone https://github.com/your-username/TSDoom.git
cd TSDoom

# 依存関係をインストール
npm install

# WAD ファイルを配置
# DOOM1.WAD を data/ ディレクトリにコピー
cp /path/to/DOOM1.WAD data/

# 開発サーバーを起動
npm run dev
```

ブラウザで [http://localhost:5173](http://localhost:5173) を開いてプレイしましょう。

### プロダクションビルド

```bash
npm run build
npm run preview
```

## 🎮 操作方法

| 操作                | キー               |
| ------------------- | ------------------ |
| 前進                | `W`                |
| 後退                | `S`                |
| 左ストレイフ        | `A`                |
| 右ストレイフ        | `D`                |
| 旋回 / 照準         | マウス             |
| 射撃                | マウス左ボタン     |
| 使用 / 開く         | `E` または `Space` |
| ダッシュ            | `Shift`            |
| 武器選択            | `1`–`7`            |
| メニュー / 一時停止 | `Escape`           |
| ヘルプ              | `F1`               |

> キャンバスをクリックしてマウスポインターをキャプチャします（ポインターロック）。

## 🔧 技術スタック

| コンポーネント | 技術                                      |
| -------------- | ----------------------------------------- |
| 言語           | TypeScript                                |
| バンドラー     | Vite                                      |
| レンダリング   | HTML5 Canvas 2D（ソフトウェアレンダラー） |
| ターゲット     | ES2024                                    |

**ランタイム依存関係ゼロ。** エンジン全体がフルスクラッチで構築されており、TypeScript と Vite のみを開発依存関係として使用しています。

## 📖 参考資料

エンジンの実装はオリジナルの DOOM ソースコードに基づいています：

- [id Software DOOM ソースコード](https://github.com/id-Software/DOOM) — オリジナルの C コードベース
- [Unofficial DOOM Specs](https://doomwiki.org/wiki/Unofficial_Doom_Specs) — WAD フォーマットとデータ構造
- [DOOM Wiki](https://doomwiki.org/) — DOOM に関する包括的なリファレンス
- [Game Engine Black Book: DOOM（Fabien Sanglard）](https://fabiensanglard.net/gebbdoom/) — エンジンの詳細分析

## ⚖️ 法的事項

DOOM は id Software / ZeniMax Media / Microsoft の登録商標です。このプロジェクトはエンジンの独立した教育目的の再実装であり、著作権で保護されたゲームデータは一切含まれて**いません**。`DOOM1.WAD` ファイルはご自身でご用意ください。

## 📄 ライセンス

このプロジェクトは教育目的で現状のまま提供されています。
