# eye-guard Logo 设计稿

6 个极简几何方向的 logo 变体，主题「护眼 + 舒缓」，配色护眼绿/青色系。
所有 SVG 使用 `viewBox="0 0 100 100"` 与 `currentColor`（颜色由使用方容器控制）。

## 查看

```sh
xdg-open design/logo/showcase.html   # 交互式对比页（深浅底切换 / 小尺寸测试 / 下载）
```

## 变体一览

| # | 名称 | 意象 | 模式 | 文件 |
|---|------|------|------|------|
| 01 | 静瞳 Still Pupil | 睁视的眼：眼廓 + 实心瞳孔 | 纯几何 | `variants/01-still-pupil.svg` |
| 02 | 休止环 Rest Ring | 番茄钟循环圆环（留缺口）+ 闭合的眼 | 点阵×循环 | `variants/02-rest-ring.svg` |
| 03 | 柔波 Soft Wave | 闭目呼吸的波形 + 呼吸圆点 | 线条系统 | `variants/03-soft-wave.svg` |
| 04 | 凝露 Dew Lattice | 圆点凝成眼睛，瞳孔以留白呈现 | 点阵×几何 | `variants/04-dew-lattice.svg` |
| 05 | 息时 Rest Dial | 270° 走时弧 + 瞳孔圆心（计时/护眼同构） | 弧线×瞳孔 | `variants/05-rest-dial.svg` |
| 06 | 远山 Distant Hills | 20-20-20 远眺：山脊 + 光点 + 空气点阵 | 层次构图 | `variants/06-distant-hills.svg` |

## 配色建议

SVG 本体为 `currentColor`，落地时按底色选择：

- 浅色底：`#059669`（emerald-600）或 `#10B981`（emerald-500）
- 深色底：`#34D399`（emerald-400）
- 备选青色系：`#0891B2` / `#22D3EE`

## 定稿 · 息环 Rest Loop

最终选定 **07 息环**（休止环 × 息时的融合款）。交付物在 `final/`：

- `final/rest-loop.svg` — 品牌色版（#059669）；`final/rest-loop-dark.svg` — 深色底版（#34D399）
- `variants/07-rest-loop.svg` — currentColor 母版（源文件）
- `final/rest-loop-{1024,512,256,128,64,32}.png` — RGBA 透明底尺寸阶梯
- 交付页：`final.html`（几何规格 / 色板 / 下载 / 接入指引）

应用接入：`pnpm tauri icon design/logo/final/rest-loop-1024.png`

托盘图标：

- 常规态（idle/work）跟随 `default_window_icon`，重生成应用图标后自动换新
- 休息态 `src-tauri/icons/tray-break.png` 已配套重绘（`final/tray-break.svg` 源文件）：
  蓝色圆角底 `#377BEE`（沿用旧版配色）+ 白色息环，线宽加粗至 6/100 以适配 32px 托盘
- 重新生成：`rsvg-convert -w 32 -h 32 design/logo/final/tray-break.svg -o src-tauri/icons/tray-break.png`
- 注：`pnpm tauri icon` 会附带生成 `icons/android/`、`icons/ios/`，纯桌面项目可直接删除

> Nano Banana 场景展示图（Phase 4 可选项）未配置 `GEMINI_API_KEY`，已跳过；配置后可随时补做。

## 迭代轮（基于「休止环 × 息时」）

| # | 名称 | 关系 | 说明 | 文件 |
|---|------|------|------|------|
| 02a | 匀环 Even Ring | 迭代自 02 | 8 点 45° 均布，缺口移至正上方（12 点休止符） | `variants/02a-even-ring.svg` |
| 02b | 渐细 Tapered Ring | 迭代自 02 | 圆点沿循环节奏渐细，时间流向缺口 | `variants/02b-tapered-ring.svg` |
| 05a | 行进 In Motion | 迭代自 05 | 走时弧末端缀圆点，进度有了方向感 | `variants/05a-in-motion.svg` |
| 05b | 虹环 Iris Dial | 迭代自 05 | 实心瞳孔换成中空虹膜环 | `variants/05b-iris-dial.svg` |
| 07 | 息环 Rest Loop | 融合 02×05 | 270° 走时弧 + 闭眼弧，元素最少 | `variants/07-rest-loop.svg` |
| 08 | 目光 Gaze Mark | 迭代自 05 | 瞳孔右上圆孔高光（evenodd 负形） | `variants/08-gaze-mark.svg` |

迭代对比页：`iterations.html`（含迭代款托盘测试 + 原版 22px 对照）。

## 下一步

1. 从 6 个方向中挑选 2-3 个进行迭代（参数微调 / 元素组合 / 渐变）
2. 定稿后导出 1024×1024 PNG（透明底），可用技能自带 `scripts/svg_to_png.py`（cairosvg）
3. 接入应用图标：`pnpm tauri icon <icon.png>` 自动生成全平台尺寸（写入 `src-tauri/icons/`）
4. （可选）Nano Banana 高端场景展示图：需在技能目录配置 `.env` 的 `GEMINI_API_KEY`
