import { API } from 'homebridge';
import { PLATFORM_NAME } from './settings';
import { OasisMiniPlatform } from './platform';

export default (api: API) => {
  api.registerPlatform(PLATFORM_NAME, OasisMiniPlatform);
};
