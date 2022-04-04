import {API, DynamicPlatformPlugin, Logger, PlatformAccessory, PlatformConfig, Service, Characteristic} from 'homebridge';
import {Hub} from './Hub';
import {LightBulb} from './LightBulb';
import {PLATFORM_NAME, PLUGIN_NAME, RELOAD_SWITCH_NAME} from './settings';
import {DimmableLightBulb} from './DimmableLightBulb';
import {ReloadSwitch} from './ReloadSwitch';
import schedule from 'node-schedule';

export class KAKUPlatform implements DynamicPlatformPlugin {
  public readonly Service: typeof Service = this.api.hap.Service;
  public readonly Characteristic: typeof Characteristic = this.api.hap.Characteristic;
  private readonly cachedAccessories: PlatformAccessory[] = [];
  public readonly hub: Hub;

  constructor(
    public readonly logger: Logger,
    public readonly config: PlatformConfig,
    public readonly api: API,
  ) {
    this.logger.debug('Finished initializing platform:', this.config.name);
    const {email, password} = config;

    if (!email || !password) {
      throw new Error('Email and/ or password missing');
    }

    const deviceBlacklist: number[] = config.deviceBlacklist ?? [];

    if(deviceBlacklist.length > 0){
      this.logger.debug(`Blacklist contains ${deviceBlacklist.length} devices: ${deviceBlacklist}`);
    }

    const {localBackupAddress} = config;

    if(localBackupAddress){
      this.logger.debug(`Using ${localBackupAddress!} as backup ip`);
    }

    // Create a new Hub that's used in all accessories
    this.hub = new Hub(email, password, deviceBlacklist, localBackupAddress);

    // When this event is fired it means Homebridge has restored all cached accessories from disk.
    // Dynamic Platform plugins should only register new accessories after this event was fired,
    // in order to ensure they weren't added to homebridge already. This event can also be used
    // to start discovery of new accessories.
    this.api.on('didFinishLaunching', () => {
      this.setup();
      this.createReloadSwitch();

      // Rerun the setup every day so that the devices listed in HomeKit are up-to-date, the AES key for the command is up-to-date and
      // The local ip-address of your ics-2000 is up-to-date
      schedule.scheduleJob('0 0 * * *', () => {
        this.logger.info('Rerunning setup as scheduled');
        this.setup();
      });
    });
  }

  public setup() {
    this.logger.info('Setup called!');
    this.hub.login()
      .catch(error => this.logger.error(`Error logging in: ${error}`))
      .then(() => this.discoverDevices())
      .catch((error) => this.logger.error(`Error discovering devices: ${error}`));
  }

  configureAccessory(accessory: PlatformAccessory): void {
    this.logger.debug('Loading accessory from cache:', accessory.displayName);
    this.cachedAccessories.push(accessory);
  }

  /**
   * Create a new instance of a Lightbulb
   * Currently, device types is limited to on/off switches (LightBulbs in this library)
   * and dimmable lights (DimmableLightBulb in this library)
   * I don't have other types of devices
   * @param accessory The accessory object you want to create a new Device with
   * @param deviceType The device type, this is stored in device json as followed: data->module->device
   * but also stored as device key in the device object itself (see Hub.ts)
   * @private
   */
  private createDevice(accessory: PlatformAccessory, deviceType: number) {
    switch (deviceType) {
      case 48: // 48 is dimmable group
      case 34: // 34 is dimmable
        new DimmableLightBulb(this, accessory);
        break;
      case 36: // 36 is a dimmable IKEA/HUE light
        new DimmableLightBulb(this, accessory);
        break;
      case 40: // 40 is a dimmable lightbulb
        new DimmableLightBulb(this, accessory);
        break;
      default:
        new LightBulb(this, accessory);
    }
  }

  private async discoverDevices() {
    // Search hub and pull devices from the server
    this.logger.info('Searching hub');
    const hubIp = await this.hub.discoverHubLocal(10_000, this.logger);
    this.logger.info(`Found hub: ${hubIp}`);
    this.logger.info('Pulling devices from server');
    const foundDevices = await this.hub.pullDevices();
    this.logger.info(`Found ${foundDevices.length} devices`);

    for (const device of foundDevices) {
      const uuid = this.api.hap.uuid.generate(device['id']);
      const existingAccessory = this.cachedAccessories.find(accessory => accessory.UUID === uuid);

      // Create the accessory
      if (existingAccessory) {
        this.createDevice(existingAccessory, device['device']);
        this.logger.info(`Loaded device from cache: ${existingAccessory.context.name}: ${device['device']}`);
      } else {
        const deviceName = device['name'];
        const accessory = new this.api.platformAccessory(deviceName, uuid);

        // store a copy of the device object in the `accessory.context`
        accessory.context.device = device;
        accessory.context.name = deviceName;

        this.createDevice(accessory, device['device']);
        this.logger.info(`Loaded new device: ${deviceName}`);
        this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
      }
    }
  }

  /**
   * Create a reload switch, so you can rerun the setup without touching homebridge
   * @private
   */
  private createReloadSwitch(){
    const uuid = this.api.hap.uuid.generate(RELOAD_SWITCH_NAME);
    const existingAccessory = this.cachedAccessories.find(accessory => accessory.UUID === uuid);

    if (existingAccessory) {
      new ReloadSwitch(this, existingAccessory);
    } else {
      const reloadSwitchAccessory = new this.api.platformAccessory(RELOAD_SWITCH_NAME, uuid);
      new ReloadSwitch(this, reloadSwitchAccessory);
      this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [reloadSwitchAccessory]);
    }

    this.logger.info('Created reload switch');
  }
}