import {
  Service,
  PlatformAccessory,
  CharacteristicValue,
} from 'homebridge';

import { OasisMiniPlatform } from './platform';
import { OasisApi } from './oasisApi';

/**
 * Drawing Accessory - Controls Play/Pause state of the Oasis Mini
 * ON = Drawing is playing
 * OFF = Drawing is paused/stopped
 */
export class OasisDrawingAccessory {
  private service: Service;
  private isPlaying = false;

  constructor(
    private readonly platform: OasisMiniPlatform,
    private readonly accessory: PlatformAccessory,
    private readonly oasisApi: OasisApi,
    private readonly pollingInterval: number,
  ) {
    // Set accessory information
    this.accessory.getService(this.platform.Service.AccessoryInformation)!
      .setCharacteristic(this.platform.Characteristic.Manufacturer, 'Oasis')
      .setCharacteristic(this.platform.Characteristic.Model, 'Mini')
      .setCharacteristic(this.platform.Characteristic.SerialNumber, accessory.context.device.serial || 'Unknown');

    // Get or create Switch service
    this.service = this.accessory.getService(this.platform.Service.Switch) ||
      this.accessory.addService(this.platform.Service.Switch);

    this.service.setCharacteristic(this.platform.Characteristic.Name, accessory.context.device.name);

    // Register handlers
    this.service.getCharacteristic(this.platform.Characteristic.On)
      .onSet(this.setOn.bind(this))
      .onGet(this.getOn.bind(this));

    // Listen for status updates from MQTT
    this.oasisApi.onStatusUpdate((status) => {
      const playing = this.oasisApi.isPlaying(status.status);
      if (this.isPlaying !== playing) {
        this.platform.log.info(`[Drawing] ${playing ? 'Playing' : 'Paused'} (was ${this.isPlaying ? 'playing' : 'paused'})`);
        this.isPlaying = playing;
        this.service.updateCharacteristic(this.platform.Characteristic.On, this.isPlaying);
      }
    });

    // Initial status fetch - delay slightly to ensure MQTT has status
    setTimeout(() => this.updateStatus(), 2000);

    // Start polling (as backup to MQTT)
    setInterval(() => {
      this.updateStatus();
    }, this.pollingInterval);
  }

  async setOn(value: CharacteristicValue) {
    const targetState = value as boolean;
    this.platform.log.info(`[Drawing] ${targetState ? 'Playing' : 'Pausing'}...`);

    try {
      if (targetState) {
        await this.oasisApi.play();
      } else {
        await this.oasisApi.pause();
      }
      this.isPlaying = targetState;
    } catch (error) {
      this.platform.log.error('[Drawing] Failed:', error);
      throw new this.platform.api.hap.HapStatusError(
        this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE,
      );
    }
  }

  async getOn(): Promise<CharacteristicValue> {
    return this.isPlaying;
  }

  private async updateStatus() {
    try {
      const status = await this.oasisApi.getStatus();
      const playing = this.oasisApi.isPlaying(status.status);

      if (this.isPlaying !== playing) {
        this.platform.log.info(`[Drawing] Sync: ${playing ? 'Playing' : 'Paused'}`);
        this.isPlaying = playing;
        this.service.updateCharacteristic(this.platform.Characteristic.On, this.isPlaying);
      }
    } catch {
      // Silently fail polling
    }
  }
}
