import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

// shadcn-vue 组件的条件类名合并（clsx 组合 + tailwind-merge 去冲突）
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
