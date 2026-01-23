import {
  Service,
  PlatformAccessory,
  CharacteristicValue,
} from 'homebridge';

import { OasisMiniPlatform } from './platform';

// LED Effect mapping from Oasis Mini
const LED_EFFECTS: { id: number; name: string }[] = [
  { id: 0, name: 'Solid' },
  { id: 1, name: 'Rainbow' },
  { id: 2, name: 'Glitter' },
  { id: 3, name: 'Confetti' },
  { id: 4, name: 'Sinelon' },
  { id: 5, name: 'BPM' },
  { id: 6, name: 'Juggle' },
  { id: 7, name: 'Theater' },
  { id: 8, name: 'Color Wipe' },
  { id: 9, name: 'Sparkle' },
  { id: 10, name: 'Comet' },
  { id: 11, name: 'Follow Ball' },
  { id: 12, name: 'Follow Rainbow' },
  { id: 13, name: 'Chasing Comet' },
  { id: 14, name: 'Gradient Follow' },
  { id: 15, name: 'Cumulative Fill' },
  { id: 16, name: 'Multi Comets A' },
  { id: 17, name: 'Rainbow Chaser' },
  { id: 18, name: 'Twinkle Lights' },
  { id: 19, name: 'Tennis Game' },
  { id: 20, name: 'Breathing 4-7-8' },
  { id: 21, name: 'Cylon Scanner' },
  { id: 22, name: 'Palette Mode' },
  { id: 23, name: 'Aurora Flow' },
  { id: 24, name: 'Colorful Drops' },
  { id: 25, name: 'Color Snake' },
  { id: 26, name: 'Flickering Candles' },
  { id: 27, name: 'Digital Rain' },
  { id: 28, name: 'Center Explosion' },
  { id: 29, name: 'Rainbow Plasma' },
  { id: 30, name: 'Comet Race' },
  { id: 31, name: 'Color Waves' },
  { id: 32, name: 'Meteor Storm' },
  { id: 33, name: 'Firefly Flicker' },
  { id: 34, name: 'Ripple' },
  { id: 35, name: 'Jelly Bean' },
  { id: 36, name: 'Forest Rain' },
  { id: 37, name: 'Multi Comets' },
  { id: 38, name: 'Multi Comets BG' },
  { id: 39, name: 'Rainbow Fill' },
  { id: 40, name: 'White Red Comet' },
  { id: 41, name: 'Color Comets' },
  { id: 42, name: 'Rainbow Smooth' },
];

/**
 * LED Effect Accessory - Controls LED effect/mode selection
 * Uses Television service to allow selecting from 43 different LED effects
 */
export class OasisLedEffectAccessory {
  private tvService: Service;
  private inputServices: Service[] = [];
  private currentEffect = 0;

  constructor(
    private readonly platform: OasisMiniPlatform,
    private readonly accessory: PlatformAccessory,
  ) {
    // Set accessory information
    this.accessory.getService(this.platform.Service.AccessoryInformation)!
      .setCharacteristic(this.platform.Characteristic.Manufacturer, 'Oasis')
      .setCharacteristic(this.platform.Characteristic.Model, 'Mini LED Effects')
      .setCharacteristic(this.platform.Characteristic.SerialNumber, this.platform.config.serial || 'Unknown');

    // Get or create Television service
    this.tvService = this.accessory.getService(this.platform.Service.Television) ||
      this.accessory.addService(this.platform.Service.Television);

    this.tvService
      .setCharacteristic(this.platform.Characteristic.ConfiguredName, accessory.context.device.name)
      .setCharacteristic(this.platform.Characteristic.SleepDiscoveryMode,
        this.platform.Characteristic.SleepDiscoveryMode.ALWAYS_DISCOVERABLE);

    // Register handlers for Active (on/off)
    this.tvService.getCharacteristic(this.platform.Characteristic.Active)
      .onSet(this.setActive.bind(this))
      .onGet(this.getActive.bind(this));

    // Register handlers for ActiveIdentifier (current input/effect)
    this.tvService.getCharacteristic(this.platform.Characteristic.ActiveIdentifier)
      .onSet(this.setActiveIdentifier.bind(this))
      .onGet(this.getActiveIdentifier.bind(this));

    // Create input sources for each effect
    this.setupInputSources();

    // Listen for status updates from MQTT
    this.platform.oasisApi.onStatusUpdate((status) => {
      if (this.currentEffect !== status.led_effect) {
        this.platform.log.info(`[LED Effect] Changed to: ${LED_EFFECTS[status.led_effect]?.name || status.led_effect}`);
        this.currentEffect = status.led_effect;
        this.tvService.updateCharacteristic(
          this.platform.Characteristic.ActiveIdentifier,
          this.currentEffect,
        );
      }
    });

    // Initial status fetch
    this.updateStatus();
  }

  private setupInputSources() {
    // Remove any existing input sources
    const existingInputs = this.accessory.services.filter(
      s => s.UUID === this.platform.Service.InputSource.UUID,
    );
    existingInputs.forEach(s => this.accessory.removeService(s));

    // Create input source for each LED effect
    for (const effect of LED_EFFECTS) {
      const inputService = this.accessory.addService(
        this.platform.Service.InputSource,
        effect.name,
        effect.id.toString(),
      );

      inputService
        .setCharacteristic(this.platform.Characteristic.Identifier, effect.id)
        .setCharacteristic(this.platform.Characteristic.ConfiguredName, effect.name)
        .setCharacteristic(this.platform.Characteristic.IsConfigured,
          this.platform.Characteristic.IsConfigured.CONFIGURED)
        .setCharacteristic(this.platform.Characteristic.InputSourceType,
          this.platform.Characteristic.InputSourceType.APPLICATION)
        .setCharacteristic(this.platform.Characteristic.CurrentVisibilityState,
          this.platform.Characteristic.CurrentVisibilityState.SHOWN);

      // Link input source to TV service
      this.tvService.addLinkedService(inputService);
      this.inputServices.push(inputService);
    }
  }

  async setActive(value: CharacteristicValue) {
    // Television Active just means the "TV" is available
    // We don't need to do anything special here
    this.platform.log.debug(`[LED Effect] Active set to: ${value}`);
  }

  async getActive(): Promise<CharacteristicValue> {
    // Always report as active
    return this.platform.Characteristic.Active.ACTIVE;
  }

  async setActiveIdentifier(value: CharacteristicValue) {
    const effectId = value as number;
    const effect = LED_EFFECTS.find(e => e.id === effectId);

    this.platform.log.info(`[LED Effect] Setting to: ${effect?.name || effectId}`);

    try {
      await this.platform.oasisApi.setLedEffect(effectId);
      this.currentEffect = effectId;
    } catch (error) {
      this.platform.log.error('[LED Effect] Failed to set effect:', error);
      throw new this.platform.api.hap.HapStatusError(
        this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE,
      );
    }
  }

  async getActiveIdentifier(): Promise<CharacteristicValue> {
    return this.currentEffect;
  }

  private async updateStatus() {
    try {
      const status = await this.platform.oasisApi.getStatus();
      if (this.currentEffect !== status.led_effect) {
        this.currentEffect = status.led_effect;
        this.tvService.updateCharacteristic(
          this.platform.Characteristic.ActiveIdentifier,
          this.currentEffect,
        );
      }
    } catch {
      // Silently fail
    }
  }
}
