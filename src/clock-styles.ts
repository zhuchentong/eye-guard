// 时钟样式注册表：新增风格的唯一注册点。
// 扩展步骤：① 在 src/clock.ts 的 CLOCK_STYLE_IDS 联合类型中加 id（Record 穷尽
// 校验会在此处报错提醒）② 实现符合 face 契约的组件 ③ 在 CLOCK_STYLES 加一行。
// 设置页选项由 CLOCK_STYLE_LIST 生成，自动出现在 UI 中。
import type { Component } from "vue";
import type { ClockStyleId } from "./clock";
import AnalogClock from "./components/AnalogClock.vue";
import DigitalFace from "./components/DigitalFace.vue";

export interface ClockStyleDef {
  id: ClockStyleId;
  /** 设置页显示名 */
  label: string;
  /** face 组件：props { value: number; total?: number }，只渲染不计算 */
  component: Component;
}

export const CLOCK_STYLES: Record<ClockStyleId, ClockStyleDef> = {
  digital: { id: "digital", label: "数字", component: DigitalFace },
  clock: { id: "clock", label: "表盘", component: AnalogClock },
};

/** 设置页遍历用（稳定顺序 = 联合类型声明顺序）。 */
export const CLOCK_STYLE_LIST: ClockStyleDef[] = Object.values(CLOCK_STYLES);
