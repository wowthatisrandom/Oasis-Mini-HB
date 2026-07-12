import {
  Service,
  PlatformAccessory,
  CharacteristicValue,
} from 'homebridge';

import { OasisMiniPlatform } from './platform';
import { OasisApi } from './oasisApi';

/**
 * Power Accessory - Controls Wake/Sleep state of the Oasis Mini
 * ON = Device is awake (not sleeping)
 * OFF = Device is in sleep mode
 */
export class OasisPowerAccessory {
  private service: Service;
  private isAwake = false;

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
      const awake = this.oasisApi.isAwake(status.status);
      if (this.isAwake !== awake) {
        this.platform.log.info(`[Power] ${awake ? 'Awake' : 'Asleep'} (was ${this.isAwake ? 'awake' : 'asleep'})`);
        this.isAwake = awake;
        this.service.updateCharacteristic(this.platform.Characteristic.On, this.isAwake);
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
    this.platform.log.info(`[Power] ${targetState ? 'Waking' : 'Sleeping'}...`);

    try {
      if (targetState) {
        await this.oasisApi.wake();
      } else {
        await this.oasisApi.sleep();
      }
      this.isAwake = targetState;
    } catch (error) {
      this.platform.log.error('[Power] Failed:', error);
      throw new this.platform.api.hap.HapStatusError(
        this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE,
      );
    }
  }

  async getOn(): Promise<CharacteristicValue> {
    return this.isAwake;
  }

  private async updateStatus() {
    try {
      const status = await this.oasisApi.getStatus();
      const awake = this.oasisApi.isAwake(status.status);

      if (this.isAwake !== awake) {
        this.platform.log.info(`[Power] Sync: ${awake ? 'Awake' : 'Asleep'}`);
        this.isAwake = awake;
        this.service.updateCharacteristic(this.platform.Characteristic.On, this.isAwake);
      }
    } catch {
      // Silently fail polling
    }
  }
}
