import { describe, expect, test } from "bun:test";
import { deliveryView } from "./format";

describe("deliveryView", () => {
  test("classifies delivery states with a disposition", () => {
    expect(deliveryView("failed", "not_sent")).toEqual({
      label: "未送达",
      verify: false,
    });
    expect(deliveryView("unknown", "unknown")).toEqual({
      label: "投递结果待核验",
      verify: true,
    });
    expect(deliveryView("delivered", "admitted")).toEqual({
      label: "已送入会话",
      verify: false,
    });
    expect(deliveryView("saved")).toEqual({
      label: "已保存",
      verify: false,
    });
  });

  test("legacy failed rows without a disposition stay unclassified", () => {
    expect(deliveryView("failed")).toEqual({
      label: "历史记录 · 投递结果待核验",
      verify: true,
    });
  });
});
