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
import { OasisApi, fetchAccountDevices } from './oasisApi';
import { OasisPowerAccessory } from './oasisPowerAccessory';
import { OasisDrawingAccessory } from './oasisDrawingAccessory';
import { OasisLightAccessory } from './oasisLightAccessory';
import { OasisLedEffectAccessory } from './oasisLedEffectAccessory';

interface TableConfig {
  serial: string;
  name?: string;
  model?: string;
}

export class OasisMiniPlatform implements DynamicPlatformPlugin {
  public readonly Service: typeof Service;
  public readonly Characteristic: typeof Characteristic;

  public readonly accessories: PlatformAccessory[] = [];
  private readonly configuredTables: TableConfig[] = [];
  private readonly apis = new Map<string, OasisApi>();
  private credentialsOk = false;

  constructor(
    public readonly log: Logger,
    public readonly config: PlatformConfig,
    public readonly api: API,
  ) {
    this.Service = api.hap.Service;
    this.Characteristic = api.hap.Characteristic;

    this.log.info('Initializing platform:', this.config.name);

    if (!config.email || !config.password) {
      this.log.error('No Oasis account credentials configured. The Oasis cloud now requires ' +
        'your account email and password — add "email" and "password" to the plugin config ' +
        '(the same login you use in the official Oasis app).');
      return;
    }
    this.credentialsOk = true;

    // Explicitly-pinned serials (optional). If none, we auto-discover every
    // device on the account at launch.
    this.configuredTables = this.resolveTables();

    this.api.on('didFinishLaunching', () => {
      this.log.info('Homebridge finished launching, discovering devices...');
      this.discoverDevices().catch((err) => {
        this.log.error('Device discovery failed:', err);
      });
    });
  }

  /** Normalize config into a list of tables: `tables` array, falling back to single `serial`. */
  private resolveTables(): TableConfig[] {
    const tables: TableConfig[] = [];
    const seen = new Set<string>();
    const add = (serial: unknown, name?: unknown) => {
      if (typeof serial !== 'string' || serial.trim() === '') {
        return;
      }
      const normalized = serial.trim().toUpperCase();
      if (seen.has(normalized)) {
        this.log.warn(`Duplicate table serial ${normalized} ignored`);
        return;
      }
      seen.add(normalized);
      tables.push({ serial: normalized, name: typeof name === 'string' && name.trim() !== '' ? name.trim() : undefined });
    };

    if (Array.isArray(this.config.tables)) {
      for (const entry of this.config.tables) {
        if (entry && typeof entry === 'object') {
          add((entry as TableConfig).serial, (entry as TableConfig).name);
        }
      }
    }
    add(this.config.serial);
    return tables;
  }

  configureAccessory(accessory: PlatformAccessory) {
    this.log.info('Loading accessory from cache:', accessory.displayName);
    this.accessories.push(accessory);
  }

  async discoverDevices() {
    if (!this.credentialsOk) {
      return;
    }
    const pollingInterval = (this.config.pollingInterval || 30) * 1000;
    const baseName = this.config.name || 'Oasis Mini';

    // Pinned serials win; otherwise ask the account what's registered.
    let tables = this.configuredTables;
    if (tables.length === 0) {
      try {
        const discovered = await fetchAccountDevices(this.config.email, this.config.password);
        tables = discovered.map(d => ({ serial: d.serial, name: d.name, model: d.model }));
        if (tables.length === 0) {
          this.log.warn('No devices found on this Oasis account — nothing to add. ' +
            'Confirm the table is registered in the official Oasis app.');
          return;
        }
        this.log.info(`Auto-discovered ${tables.length} device(s): ${tables.map(t => t.serial).join(', ')}`);
      } catch (err) {
        this.log.error('Auto-discovery failed. You can pin serials manually via "serial"/"tables" ' +
          'in the config to bypass discovery. Error:', err);
        return;
      }
    }

    // Build a fresh API per table (constructing here, not in the ctor, so
    // auto-discovered serials are available before we connect).
    for (const table of tables) {
      if (!this.apis.has(table.serial)) {
        // Use log.info so logs are visible (not hidden debug)
        this.apis.set(
          table.serial,
          new OasisApi(table.serial, this.config.email, this.config.password, this.log.info.bind(this.log)),
        );
      }
    }

    // Connect all tables concurrently; one offline table must not block the rest.
    await Promise.all(tables.map(async (table) => {
      try {
        await this.apis.get(table.serial)!.connect();
        this.log.info(`Connected to ${table.serial} via MQTT`);
      } catch (err) {
        this.log.error(`Failed to connect to ${table.serial}:`, err);
        // Continue anyway - accessories will work once connection is established
      }
    }));

    const validUuids: string[] = [];
    const usedNames = new Set<string>();

    // Display name priority: the name set on the table in the Oasis app (or a
    // pinned config name), then the model ("Side Table"), then the configured
    // base name. Duplicates get a numeric suffix so two same-model tables stay
    // distinct.
    const resolveName = (table: TableConfig): string => {
      const preferred = table.name || table.model || baseName;
      let name = preferred;
      let n = 2;
      while (usedNames.has(name)) {
        name = `${preferred} ${n++}`;
      }
      usedNames.add(name);
      return name;
    };

    tables.forEach((table) => {
      const oasisApi = this.apis.get(table.serial)!;
      const deviceName = resolveName(table);

      const powerUuid = this.api.hap.uuid.generate(`${PLUGIN_NAME}-power-${table.serial}`);
      const drawingUuid = this.api.hap.uuid.generate(`${PLUGIN_NAME}-drawing-${table.serial}`);
      const lightUuid = this.api.hap.uuid.generate(`${PLUGIN_NAME}-light-${table.serial}`);
      const effectUuid = this.api.hap.uuid.generate(`${PLUGIN_NAME}-effect-${table.serial}`);
      validUuids.push(powerUuid, drawingUuid, lightUuid, effectUuid);

      const setup = (
        uuid: string,
        name: string,
        create: (accessory: PlatformAccessory) => void,
        category?: number,
      ) => {
        const existing = this.accessories.find(acc => acc.UUID === uuid);
        if (existing) {
          this.log.info('Restoring existing accessory from cache:', existing.displayName);
          existing.context.device = { name, serial: table.serial };
          create(existing);
        } else {
          this.log.info('Adding new accessory:', name);
          const accessory = new this.api.platformAccessory(name, uuid, category);
          accessory.context.device = { name, serial: table.serial };
          create(accessory);
          this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
        }
      };

      setup(powerUuid, deviceName,
        acc => new OasisPowerAccessory(this, acc, oasisApi, pollingInterval));
      setup(drawingUuid, `${deviceName} Drawing`,
        acc => new OasisDrawingAccessory(this, acc, oasisApi, pollingInterval));
      setup(lightUuid, `${deviceName} Light`,
        acc => new OasisLightAccessory(this, acc, oasisApi, pollingInterval));
      setup(effectUuid, `${deviceName} LED Effect`,
        acc => new OasisLedEffectAccessory(this, acc, oasisApi),
        this.api.hap.Categories.TELEVISION);
    });

    // Remove stale cached accessories that don't belong to any configured table
    const staleAccessories = this.accessories.filter(acc => !validUuids.includes(acc.UUID));
    if (staleAccessories.length > 0) {
      this.log.info(`Removing ${staleAccessories.length} stale cached accessories`);
      this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, staleAccessories);
    }
  }
}
