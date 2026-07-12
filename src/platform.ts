import {
  API,
  DynamicPlatformPlugin,
  Logger,
  PlatformAccessory,
  PlatformConfig,
  Service,
  Characteristic,
} from 'homebridge';

import { PLATFORM_NAME, PLUGIN_NAME } from './settings';
import { OasisApi } from './oasisApi';
import { OasisPowerAccessory } from './oasisPowerAccessory';
import { OasisDrawingAccessory } from './oasisDrawingAccessory';
import { OasisLightAccessory } from './oasisLightAccessory';
import { OasisLedEffectAccessory } from './oasisLedEffectAccessory';

export class OasisMiniPlatform implements DynamicPlatformPlugin {
  public readonly Service: typeof Service;
  public readonly Characteristic: typeof Characteristic;

  public readonly accessories: PlatformAccessory[] = [];
  public oasisApi!: OasisApi;

  constructor(
    public readonly log: Logger,
    public readonly config: PlatformConfig,
    public readonly api: API,
  ) {
    this.Service = api.hap.Service;
    this.Characteristic = api.hap.Characteristic;

    this.log.info('Initializing platform:', this.config.name);

    if (!config.serial) {
      this.log.error('No serial number configured for Oasis Mini. Please configure the serial number.');
      return;
    }

    if (!config.email || !config.password) {
      this.log.error('No Oasis account credentials configured. The Oasis cloud now requires ' +
        'your account email and password — add "email" and "password" to the plugin config ' +
        '(the same login you use in the official Oasis app).');
      return;
    }

    this.log.info('Serial number:', config.serial);

    // Use log.info so logs are visible (not hidden debug)
    this.oasisApi = new OasisApi(config.serial, config.email, config.password, this.log.info.bind(this.log));

    this.api.on('didFinishLaunching', () => {
      this.log.info('Homebridge finished launching, discovering devices...');
      this.discoverDevices();
    });
  }

  configureAccessory(accessory: PlatformAccessory) {
    this.log.info('Loading accessory from cache:', accessory.displayName);
    this.accessories.push(accessory);
  }

  async discoverDevices() {
    if (!this.oasisApi) {
      this.log.error('Cannot discover devices: API not initialized');
      return;
    }

    // Connect to MQTT FIRST before creating accessories
    try {
      await this.oasisApi.connect();
      this.log.info('Connected to Oasis Mini via MQTT');
    } catch (err) {
      this.log.error('Failed to connect to Oasis Mini:', err);
      // Continue anyway - accessories will work once connection is established
    }

    const deviceName = this.config.name || 'Oasis Mini';
    const pollingInterval = (this.config.pollingInterval || 30) * 1000;

    // Generate UUIDs for all four accessories
    const powerUuid = this.api.hap.uuid.generate(`${PLUGIN_NAME}-power-${this.config.serial}`);
    const drawingUuid = this.api.hap.uuid.generate(`${PLUGIN_NAME}-drawing-${this.config.serial}`);
    const lightUuid = this.api.hap.uuid.generate(`${PLUGIN_NAME}-light-${this.config.serial}`);
    const effectUuid = this.api.hap.uuid.generate(`${PLUGIN_NAME}-effect-${this.config.serial}`);

    // Valid UUIDs for this device
    const validUuids = [powerUuid, drawingUuid, lightUuid, effectUuid];

    // Remove stale cached accessories that don't match our current UUIDs
    const staleAccessories = this.accessories.filter(acc => !validUuids.includes(acc.UUID));
    if (staleAccessories.length > 0) {
      this.log.info(`Removing ${staleAccessories.length} stale cached accessories`);
      this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, staleAccessories);
    }

    // Check for existing accessories
    const existingPower = this.accessories.find(acc => acc.UUID === powerUuid);
    const existingDrawing = this.accessories.find(acc => acc.UUID === drawingUuid);
    const existingLight = this.accessories.find(acc => acc.UUID === lightUuid);
    const existingEffect = this.accessories.find(acc => acc.UUID === effectUuid);

    // 1. Power accessory (Wake/Sleep)
    const powerName = `${deviceName}`;
    if (existingPower) {
      this.log.info('Restoring existing accessory from cache:', existingPower.displayName);
      new OasisPowerAccessory(this, existingPower, pollingInterval);
    } else {
      this.log.info('Adding new accessory:', powerName);
      const accessory = new this.api.platformAccessory(powerName, powerUuid);
      accessory.context.device = {
        name: powerName,
        serial: this.config.serial,
      };
      new OasisPowerAccessory(this, accessory, pollingInterval);
      this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
    }

    // 2. Drawing accessory (Play/Pause)
    const drawingName = `${deviceName} Drawing`;
    if (existingDrawing) {
      this.log.info('Restoring existing accessory from cache:', existingDrawing.displayName);
      new OasisDrawingAccessory(this, existingDrawing, pollingInterval);
    } else {
      this.log.info('Adding new accessory:', drawingName);
      const accessory = new this.api.platformAccessory(drawingName, drawingUuid);
      accessory.context.device = {
        name: drawingName,
        serial: this.config.serial,
      };
      new OasisDrawingAccessory(this, accessory, pollingInterval);
      this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
    }

    // 3. Light accessory (LED)
    const lightName = `${deviceName} Light`;
    if (existingLight) {
      this.log.info('Restoring existing accessory from cache:', existingLight.displayName);
      new OasisLightAccessory(this, existingLight, pollingInterval);
    } else {
      this.log.info('Adding new accessory:', lightName);
      const accessory = new this.api.platformAccessory(lightName, lightUuid);
      accessory.context.device = {
        name: lightName,
        serial: this.config.serial,
      };
      new OasisLightAccessory(this, accessory, pollingInterval);
      this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
    }

    // 4. LED Effect accessory (LED Mode/Effect selector)
    const effectName = `${deviceName} LED Effect`;
    if (existingEffect) {
      this.log.info('Restoring existing accessory from cache:', existingEffect.displayName);
      new OasisLedEffectAccessory(this, existingEffect);
    } else {
      this.log.info('Adding new accessory:', effectName);
      const accessory = new this.api.platformAccessory(effectName, effectUuid, this.api.hap.Categories.TELEVISION);
      accessory.context.device = {
        name: effectName,
        serial: this.config.serial,
      };
      new OasisLedEffectAccessory(this, accessory);
      this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
    }
  }
}
