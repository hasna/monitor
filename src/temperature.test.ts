import { describe, expect, it } from "bun:test";
import { parseTemperatureOutput } from "./temperature.js";

describe("temperature helpers", () => {
  it("parses linux thermal, nvidia, and fan sections", () => {
    const parsed = parseTemperatureOutput([
      "__SECTION__=thermal",
      "CPU-therm\t41.7",
      "__SECTION__=nvidia",
      "NVIDIA GB10, 39, [N/A]",
      "__SECTION__=fans",
      "pwmfan/fan1\t3200",
    ].join("\n"));

    expect(parsed).toEqual({
      cpu: [{ label: "CPU-therm", temperatureC: 41.7 }],
      gpu: [{ label: "NVIDIA GB10", temperatureC: 39 }],
      fans: [
        { label: "NVIDIA GB10 fan", rpm: null },
        { label: "pwmfan/fan1", rpm: 3200 },
      ],
    });
  });
});
