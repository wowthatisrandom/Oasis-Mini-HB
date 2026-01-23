import {
  Service,
  PlatformAccessory,
  CharacteristicValue,
} from 'homebridge';

import { OasisMiniPlatform } from './platform';

export class OasisLightAccessory {
  private service: Service;

  // Current state
  private isOn = true;
  private brightness = 100;
  private hue = 0;
  private saturation = 0;

  // Store RGB values for when light is off
  private lastRgb = { r: 255, g: 255, b: 255 };

  constructor(
    private readonly platform: OasisMiniPlatform,
    private readonly accessory: PlatformAccessory,
    private readonly pollingInterval: number,
  ) {
    // Set accessory information
    this.accessory.getService(this.platform.Service.AccessoryInformation)!
      .setCharacteristic(this.platform.Characteristic.Manufacturer, 'Oasis')
      .setCharacteristic(this.platform.Characteristic.Model, 'Mini LED')
      .setCharacteristic(this.platform.Characteristic.SerialNumber, this.platform.config.serial || 'Unknown');

    // Get or create Lightbulb service
    this.service = this.accessory.getService(this.platform.Service.Lightbulb) ||
      this.accessory.addService(this.platform.Service.Lightbulb);

    this.service.setCharacteristic(this.platform.Characteristic.Name, accessory.context.device.name);

    // Register handlers for On/Off
    this.service.getCharacteristic(this.platform.Characteristic.On)
      .onSet(this.setOn.bind(this))
      .onGet(this.getOn.bind(this));

    // Register handlers for Brightness
    this.service.getCharacteristic(this.platform.Characteristic.Brightness)
      .onSet(this.setBrightness.bind(this))
      .onGet(this.getBrightness.bind(this));

    // Register handlers for Hue
    this.service.getCharacteristic(this.platform.Characteristic.Hue)
      .onSet(this.setHue.bind(this))
      .onGet(this.getHue.bind(this));

    // Register handlers for Saturation
    this.service.getCharacteristic(this.platform.Characteristic.Saturation)
      .onSet(this.setSaturation.bind(this))
      .onGet(this.getSaturation.bind(this));

    // Listen for status updates from MQTT
    this.platform.oasisApi.onStatusUpdate((status) => {
      this.updateFromStatus(status);
    });

    // Initial status fetch
    this.updateStatus();

    // Start polling (as backup to MQTT)
    setInterval(() => {
      this.updateStatus();
    }, this.pollingInterval);
  }

  private updateFromStatus(status: { led_r: number; led_g: number; led_b: number; brightness: number }) {
    const isCurrentlyOn = status.brightness > 0;

    if (isCurrentlyOn) {
      this.lastRgb = { r: status.led_r, g: status.led_g, b: status.led_b };
      const hsb = this.rgbToHsb(status.led_r, status.led_g, status.led_b);
      this.hue = hsb.h;
      this.saturation = hsb.s;
      // Device may report 0-255 or 0-100, clamp to HomeKit's 0-100 range
      this.brightness = Math.min(100, Math.max(0, status.brightness > 100
        ? Math.round((status.brightness / 255) * 100)
        : status.brightness));
      this.isOn = true;
    } else {
      this.isOn = false;
    }

    this.platform.log.debug(`[Light] Status update: on=${this.isOn}, brightness=${this.brightness}, hue=${this.hue}, sat=${this.saturation}`);

    // Update HomeKit
    this.service.updateCharacteristic(this.platform.Characteristic.On, this.isOn);
    this.service.updateCharacteristic(this.platform.Characteristic.Brightness, this.brightness);
    this.service.updateCharacteristic(this.platform.Characteristic.Hue, this.hue);
    this.service.updateCharacteristic(this.platform.Characteristic.Saturation, this.saturation);
  }

  async setOn(value: CharacteristicValue) {
    this.isOn = value as boolean;

    try {
      if (this.isOn) {
        const rgb = this.hsbToRgb(this.hue, this.saturation, 100);
        await this.platform.oasisApi.setLed(rgb.r, rgb.g, rgb.b, this.brightness || 100);
      } else {
        await this.platform.oasisApi.setLedBrightness(0);
      }
    } catch (error) {
      this.platform.log.error('[Light] Failed:', error);
      throw new this.platform.api.hap.HapStatusError(
        this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE,
      );
    }
  }

  async getOn(): Promise<CharacteristicValue> {
    return this.isOn;
  }

  async setBrightness(value: CharacteristicValue) {
    this.brightness = value as number;

    try {
      await this.platform.oasisApi.setLedBrightness(this.brightness);
    } catch {
      // Silently fail
    }
  }

  async getBrightness(): Promise<CharacteristicValue> {
    return this.brightness;
  }

  async setHue(value: CharacteristicValue) {
    this.hue = value as number;
    if (this.isOn) {
      await this.updateLed();
    }
  }

  async getHue(): Promise<CharacteristicValue> {
    return this.hue;
  }

  async setSaturation(value: CharacteristicValue) {
    this.saturation = value as number;
    if (this.isOn) {
      await this.updateLed();
    }
  }

  async getSaturation(): Promise<CharacteristicValue> {
    return this.saturation;
  }

  private async updateLed() {
    try {
      const rgb = this.hsbToRgb(this.hue, this.saturation, 100);
      this.lastRgb = rgb;
      await this.platform.oasisApi.setLed(rgb.r, rgb.g, rgb.b, this.brightness);
    } catch {
      // Silently fail
    }
  }

  private async updateStatus() {
    try {
      const status = await this.platform.oasisApi.getStatus();
      this.updateFromStatus(status);
    } catch {
      // Silently fail polling
    }
  }

  /**
   * Convert HSB (Hue, Saturation, Brightness) to RGB
   * @param h Hue (0-360)
   * @param s Saturation (0-100)
   * @param b Brightness (0-100)
   */
  private hsbToRgb(h: number, s: number, b: number): { r: number; g: number; b: number } {
    // Convert to 0-1 range
    const sat = s / 100;
    const bright = b / 100;

    const c = bright * sat;
    const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
    const m = bright - c;

    let r = 0, g = 0, bl = 0;

    if (h >= 0 && h < 60) {
      r = c; g = x; bl = 0;
    } else if (h >= 60 && h < 120) {
      r = x; g = c; bl = 0;
    } else if (h >= 120 && h < 180) {
      r = 0; g = c; bl = x;
    } else if (h >= 180 && h < 240) {
      r = 0; g = x; bl = c;
    } else if (h >= 240 && h < 300) {
      r = x; g = 0; bl = c;
    } else if (h >= 300 && h < 360) {
      r = c; g = 0; bl = x;
    }

    return {
      r: Math.round((r + m) * 255),
      g: Math.round((g + m) * 255),
      b: Math.round((bl + m) * 255),
    };
  }

  /**
   * Convert RGB to HSB (Hue, Saturation, Brightness)
   * @param r Red (0-255)
   * @param g Green (0-255)
   * @param b Blue (0-255)
   */
  private rgbToHsb(r: number, g: number, b: number): { h: number; s: number; b: number } {
    // Convert to 0-1 range
    r = r / 255;
    g = g / 255;
    b = b / 255;

    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const delta = max - min;

    let h = 0;
    let s = 0;
    const bright = max * 100;

    if (delta !== 0) {
      s = (delta / max) * 100;

      if (max === r) {
        h = 60 * (((g - b) / delta) % 6);
      } else if (max === g) {
        h = 60 * ((b - r) / delta + 2);
      } else {
        h = 60 * ((r - g) / delta + 4);
      }

      if (h < 0) {
        h += 360;
      }
    }

    return {
      h: Math.round(h),
      s: Math.round(s),
      b: Math.round(bright),
    };
  }
}
