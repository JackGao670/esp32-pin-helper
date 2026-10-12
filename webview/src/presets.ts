// Camera & LCD common presets (PeripheralPanel 专用 WebView 面板)
// 目标：一键把典型 Sensor/Panel 的 signals 填进对应 peripheral 的默认路由
// 说明：所有 signal 名和 gpio 必须与 peripherals.json 声明一致
//      gpio 选择 "常见开发板可布线" 的空闲脚（避开 S3 strapping 0/3/45/46 与 memory 26-37）。

export interface PeripheralSignalPreset {
  id: string;                              // "ov2640_8bit_dvp"
  label: string;                           // "OV2640 DVP 8-bit Camera (Parallel)"
  owner: string;                           // "camera0"
  type: "camera" | "camera_mipi" | "lcd" | "lcd_mipi";
  busWidth: string;                        // "DVP 8-bit" / "MIPI CSI 2-lane" / …，UI 展示
  signals: Record<string, string>;         // signal id → GPIO string
  targetChips: ("esp32s3" | "esp32c6" | "esp32p4")[];
  notes?: string[];
}

// S3 DVP Camera 常见 8bit 管脚（避开 0/3/45/46 与 26-37；XCLK 用独立 PWM，camera 外设不含 XCLK）
const S3_CAMERA_DVP_8BIT_GPIO = {
  d0: "GPIO13", d1: "GPIO14", d2: "GPIO15", d3: "GPIO16", d4: "GPIO17", d5: "GPIO18", d6: "GPIO21", d7: "GPIO22",
  pclk: "GPIO12", vsync: "GPIO11", href: "GPIO10", sccb_sda: "GPIO8", sccb_scl: "GPIO9"
};

// P4 Camera MIPI CSI-2 2-lane（peripherals.json 声明 lane0/lane1/clk 为 string placeholder → 真实对应 GPIO30-39 的 MIPI 引脚）
const P4_CAMERA_MIPI_2LANE_GPIO = {
  d0p: "GPIO30", d0n: "GPIO31", d1p: "GPIO32", d1n: "GPIO33", clkp: "GPIO34", clkn: "GPIO35",
  sccb_sda: "GPIO18", sccb_scl: "GPIO19"
};

// S3 LCD RGB888 16bit（避开 0/3/45/46，26-37 留作 PSRAM/SPI Flash；de/hsync/vsync/pclk 用空闲脚）
const S3_LCD_RGB565_16BIT_GPIO = {
  d0: "GPIO13", d1: "GPIO14", d2: "GPIO15", d3: "GPIO16", d4: "GPIO17", d5: "GPIO18", d6: "GPIO21", d7: "GPIO22",
  d8: "GPIO38", d9: "GPIO39", d10: "GPIO40", d11: "GPIO41", d12: "GPIO42", d13: "GPIO43", d14: "GPIO44", d15: "GPIO47",
  hsync: "GPIO10", vsync: "GPIO11", pclk: "GPIO12", de: "GPIO23", cs: "GPIO24", backlight: "GPIO48"
};

// P4 LCD MIPI DSI 2-lane（peripherals.json GPIO30-39 占位）
const P4_LCD_MIPI_2LANE_GPIO = {
  d0p: "GPIO30", d0n: "GPIO31", d1p: "GPIO32", d1n: "GPIO33", clkp: "GPIO34", clkn: "GPIO35",
  backlight: "GPIO24", reset: "GPIO25"
};

export const CAMERA_PRESETS: PeripheralSignalPreset[] = [
  {
    id: "ov2640_s3_dvp_8bit",
    label: "OV2640 — DVP 8-bit (Parallel)",
    owner: "camera0",
    type: "camera",
    busWidth: "DVP 8-bit",
    targetChips: ["esp32s3"],
    signals: { ...S3_CAMERA_DVP_8BIT_GPIO },
    notes: ["XCLK typically LEDC on GPIO1 or external oscillator; camera peripheral does not expose XCLK signal."]
  },
  {
    id: "ov5640_s3_dvp_8bit",
    label: "OV5640 — DVP 8-bit (Parallel, 5MP)",
    owner: "camera0",
    type: "camera",
    busWidth: "DVP 8-bit",
    targetChips: ["esp32s3"],
    signals: { ...S3_CAMERA_DVP_8BIT_GPIO },
    notes: ["Same DVP pinout as OV2640; SCCB address 0x78 vs OV2640 0x60 — handled in firmware, not pin schema."]
  },
  {
    id: "sc2336_p4_csi_2lane",
    label: "SC2336 — MIPI CSI-2 2-lane (SmartSens, 2MP)",
    owner: "camera_mipi0",
    type: "camera_mipi",
    busWidth: "MIPI CSI-2 2-lane",
    targetChips: ["esp32p4"],
    signals: { ...P4_CAMERA_MIPI_2LANE_GPIO },
    notes: ["P4 MIPI CSI D-PHY pins (DSI_DP/DM pairs) are shared-die-dedicated; GPIO30-39 are placeholder names used by this PoC."]
  }
];

export const LCD_PRESETS: PeripheralSignalPreset[] = [
  {
    id: "st7789_s3_rgb565_16bit",
    label: "ST7789V 240x320 — SPI-like RGB565 / MCU 8080 16-bit",
    owner: "lcd0",
    type: "lcd",
    busWidth: "RGB565 / MCU 16-bit",
    targetChips: ["esp32s3"],
    signals: { ...S3_LCD_RGB565_16BIT_GPIO },
    notes: ["ST7789V MCU 8080 mode requires WRX/DCX; these are often GPIO-banged, so this preset keeps them user-definable."]
  },
  {
    id: "ili9341_s3_rgb565_16bit",
    label: "ILI9341 240x320 — MCU 8080 16-bit",
    owner: "lcd0",
    type: "lcd",
    busWidth: "RGB565 / MCU 16-bit",
    targetChips: ["esp32s3"],
    signals: { ...S3_LCD_RGB565_16BIT_GPIO },
    notes: ["ILI9341 in SPI-only mode can use a 4-pin IOMUX SPI assignment; this preset assumes MCU parallel."]
  },
  {
    id: "jd9365_p4_dsi_2lane",
    label: "JD9365 — MIPI DSI 2-lane (Dual Port eDP)",
    owner: "lcd_mipi0",
    type: "lcd_mipi",
    busWidth: "MIPI DSI 2-lane",
    targetChips: ["esp32p4"],
    signals: { ...P4_LCD_MIPI_2LANE_GPIO },
    notes: ["P4 DSI D-PHY dedicated lanes 0/1 + clock; GPIO30-35 placeholders follow this PoC's MIPI routing model."]
  }
];

export function presetOwnerInstance(preset: PeripheralSignalPreset): { type: string; instance: number } {
  const m = preset.owner.match(/^(.+?)(\d+)$/);
  return { type: preset.type, instance: Number(m?.[2] ?? 0) };
}
