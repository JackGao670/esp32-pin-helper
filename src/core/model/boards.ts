// Board Profile v0.1
// 板子级（PCB 级）覆盖：把芯片的逻辑引脚映射到开发板的物理丝印（labelOverride），
// 声明板子专用外设的默认 signal map（如 "GPIO38 → VSPI MOSI on devkitc-1"），
// 并列出板子上被其它固定用途占用的 GPIO（用户不可再分配）。
//
// 使用路径：User 选 target chip → 再选 board（如 esp32-s3-devkitc-1）→
//   Planner 合并 BoardProfile 与 Device 给出更准的 warnings 和默认值。

import type { TargetChip } from "./project";

export type PinPowerDomain =
  | "VDD3P3_CPU"
  | "VDD3P3_RTC"
  | "VDD_SPI"
  | "VDD_A"
  | "VDD33"
  | "1V8";

export interface BoardPinOverride {
  gpio: number;
  // 物理丝印，如 "GPIO17"、"IO0"、"RGB LED"、"BOOT"、"USB_D-"
  label: string;
  // 板子上此脚被固定硬件占用（不能被用户外设再分配），例如 RGB LED、BOOT key
  reserved?: boolean;
  // 若此脚在 PCB 上被硬件拉成某个 boot mode（与默认芯片 strap 方向不同），可声明
  strapDirection?: "pull-up" | "pull-down" | "floating";
}

// owner = peripheral owner 字符串（与 config.peripherals 的 key 一致，如 "vspi"、"uart0"）
export type BoardDefaultSignalMap = Record<string, Record<string, string>>;

// 板载固定用途引脚：该 GPIO 在 PCB 上焊到板载器件（USB-UART 桥、SD 卡座、以太网 PHY、共享 I2C 总线等）。
// 与 reserved 的区别：reserved 表示"这块板子不该复用此脚"，onboardPins 表示"可以复用，但会牺牲板载功能"，
// 因此只产出提示级 warning（不阻断）。若用户分配的就是该脚对应的板载 owner/signal，则不算冲突。
export interface BoardOnboardPin {
  gpio: number;
  usage: string;   // 人类可读的板载用途，如 "microSD SDMMC D0 (SD SPI MISO)"
}

export interface BoardProfile {
  id: string;                      // "esp32-s3-devkitc-1"
  name: string;                    // "ESP32-S3-DevKitC-1 (N8R8)"
  vendor: string;                  // "espressif"
  targetChip: TargetChip;          // "esp32s3"
  package?: string;                // "QFN-56"（芯片级包，非板子）
  // 同一 targetChip 下有多块板时，auto 解析用此标记挑出参考板；未标记或标记不唯一则不做猜测。
  default?: boolean;
  boardPcbVersion?: string;        // "v1.6"
  source: {
    document: string;              // 如 "ESP32-S3-DevKitC-1 User Guide"
    version: string;               // 如 "v1.6"
    url: string;                   // 官方 URL
  };
  pins: BoardPinOverride[];        // 只需要声明有 labelOverride / reserved 的脚，其它脚沿用 Device 逻辑名
  reservedGpios: number[];         // 冗余索引，loadBoard 时 pins[].reserved=true 会自动 union 到这里
  peripherals: BoardDefaultSignalMap; // owner → signal → gpio
  onboardPins?: BoardOnboardPin[];    // 板载器件固定占用的 GPIO（提示级，不阻断复用）
  powerDomain?: {
    default: PinPowerDomain;       // 所有默认未声明脚的 VDD 域
    perGpio?: Partial<Record<number, PinPowerDomain>>;
  };
  notes?: string[];
}
