let WebSocket = require('ws');
let request = require('request-json');
let nonce = require('nonce')();
let crypto = require('crypto');
let convert = require('color-convert');
const querystring = require('querystring');

let ws;
let sequence;
let webClient;
let Accessory, Service, Characteristic, UUIDGen;

module.exports = function (homebridge) {
   Accessory = homebridge.platformAccessory;
   Service = homebridge.hap.Service;
   Characteristic = homebridge.hap.Characteristic;
   UUIDGen = homebridge.hap.uuid;
   homebridge.registerPlatform("homebridge-eWeLink", "eWeLink", eWeLink, true);
};

function eWeLink(log, config, api) {
   if (!config || (!config['username'] || !config['password'] || !config['countryCode'])) {
      log.error("Please check you have set your username, password and country code in the Homebridge config.");
      return;
   }
   this.log = log;
   this.config = config;
   this.apiKey = 'UNCONFIGURED';
   this.authenticationToken = 'UNCONFIGURED';
   this.appid = 'oeVkj2lYFGnJu5XUtWisfW4utiN4u9Mq';
   this.debug = this.config['debug'] || false;
   this.debugReqRes = this.config['debugReqRes'] || false;
   this.debugInitial =    this.config['debugInitial'] || false;
   this.emailLogin = this.config['username'].includes("@") ? true : false;
   this.apiHost = (this.config['apiHost'] || 'eu-api.coolkit.cc') + ':8080';
   this.wsHost = this.config['wsHost'] || 'eu-pconnect3.coolkit.cc';
   this.webSocketOpen = false;
   this.devicesInHB = new Map();
   this.devicesInEwe = new Map();
   this.devicesUnsupported = [28];
   this.devicesSingleSwitch = [1, 5, 6, 14, 15, 22, 24, 27, 32, 36, 59];
   this.devicesSingleSwitchLight = ['T1 1C', 'L1', 'B1', 'TX1C'];
   this.devicesMultiSwitch = [2, 3, 4, 7, 8, 9, 29, 30, 31, 34, 41, 77];
   this.devicesMultiSwitchLight = ['T1 2C', 'T1 3C', 'TX2C', 'TX3C'];
   this.devicesLightbulb = [36, 59];
   this.devicesDimmable = [36];
   this.devicesColourable = [59];
   this.devicesThermostat = [15];
   this.devicesFan = [34];
   this.deviceGroups = new Map();
   this.groupDefaults = {
      "switchUp": 1,
      "switchDown": 2,
      "timeUp": 40,
      "timeDown": 20,
      "timeBottomMarginUp": 0,
      "timeBottomMarginDown": 0,
      "fullOverdrive": 0
   };
   
   let platform = this;
   if (api) {
      platform.api = api;
      platform.api.on('didFinishLaunching', function () {
         let afterLogin = function () {
            if (platform.debug) platform.log("Auth token received [%s].", platform.authenticationToken);
            if (platform.debug) platform.log("API key received [%s].", platform.apiKey);
            
            // The cached devices are stored in the "platform.devicesInHB" map with the device ID as the key (with the SW*) part
            platform.log("[%s] eWeLink devices were loaded from the Homebridge cache and will be refreshed.", platform.devicesInHB.size);
            
            // Next we need to open a web socket to the eWeLink server to receive real-time updates about external changes to devices.
            if (platform.debug) platform.log("Opening web socket for real time updates.");
            platform.ws = new WebSocketClient();
            platform.ws.open('wss://' + platform.wsHost + ':8080/api/ws');
            platform.ws.onopen = function (e) {
               platform.webSocketOpen = true;
               let payload = {};
               payload.action = "userOnline";
               payload.at = platform.authenticationToken;
               payload.apikey = platform.apiKey;
               payload.appid = platform.appid;
               payload.nonce = nonce();
               payload.ts = Math.floor(new Date() / 1000);
               payload.userAgent = 'app';
               payload.sequence = platform.getSequence();
               payload.version = 8;
               let string = JSON.stringify(payload);
               if (platform.debugReqRes) platform.log.warn("Sending web socket login request.\n" + JSON.stringify(payload, null, 2));
               else if (platform.debug) platform.log("Sending web socket login request.");
               platform.ws.send(string);
            };
            platform.ws.onmessage = function (message) {
               if (message == "pong") return;
               if (platform.debugReqRes) platform.log.warn("Web socket message received.\n" + JSON.stringify(JSON.parse(message), null, 2));
               else if (platform.debug) platform.log("Web socket message received.");
               let device;
               try {
                  device = JSON.parse(message);
               } catch (e) {
                  return;
               }
               if (device.hasOwnProperty("action")) {
                  if (device.action === 'update' && device.hasOwnProperty("params")) {
                     if (platform.debug) platform.log("External update received via web socket.");
                     let accessory;
                     let channelCount;
                     let idToCheck = device.deviceid;
                     let group;
                     
                     if (platform.devicesInHB.has(idToCheck + "SW0") || platform.devicesInHB.has(idToCheck + "SWX")) {
                        if (platform.devicesInHB.has(idToCheck + "SWX")) accessory = platform.devicesInHB.get(idToCheck + "SWX");
                        else accessory = platform.devicesInHB.get(idToCheck + "SW0");
                        if (!device.online) {
                           platform.log.warn("[%s] has been reported offline so cannot refresh.", accessory.displayName);
                           return;
                        }
                        if (platform.debug) platform.log("[%s] has been found in Homebridge so refresh status.", accessory.displayName);
                        accessory.getService(Service.AccessoryInformation).setCharacteristic(Characteristic.FirmwareRevision, device.params.fwVersion);
                        
                        //********//
                        // BLINDS //
                        //********//       
                        if (platform.deviceGroups.has(idToCheck + "SWX")) {
                           group = platform.deviceGroups.get(idToCheck + "SWX");
                           if (group.type === "blind" && Array.isArray(device.params.switches)) {
                              platform.externalBlindUpdate(idToCheck + "SWX", device.params);
                           } else {
                              platform.log.error("[%s] Problem refreshing this device.", idToCheck + "SWX");
                              return;
                           }
                        }
                        
                        //******//
                        // FANS //
                        //******//                                          
                        else if (platform.devicesFan.includes(accessory.context.eweUIID)) {
                           if (Array.isArray(device.params.switches))
                           {
                              accessory.getService(Service.Lightbulb).updateCharacteristic(Characteristic.On, device.params.switches[0].switch === 'on');
                              let status = false;
                              let speed = 0;
                              if (device.params.switches[1].switch == 'on' && device.params.switches[2].switch == 'off' && device.params.switches[3].switch == 'off') {
                                 status = true;
                                 speed = 33;
                              } else if (device.params.switches[1].switch == 'on' && device.params.switches[2].switch == 'on' && device.params.switches[3].switch == 'off') {
                                 status = true;
                                 speed = 66;
                              } else if (device.params.switches[1].switch == 'on' && device.params.switches[2].switch == 'off' && device.params.switches[3].switch == 'on') {
                                 status = true;
                                 speed = 100;
                              }
                              accessory.getService(Service.Fanv2).updateCharacteristic(Characteristic.On, status);
                              accessory.getService(Service.Fanv2).updateCharacteristic(Characteristic.RotationSpeed, speed);
                           } else {
                              platform.log.error("[%s] Problem refreshing this device.", idToCheck + "SWX");
                              return;
                           }
                        }
                        
                        //*************//
                        // THERMOSTATS //
                        //*************//                                    
                        else if (platform.devicesThermostat.includes(accessory.context.eweUIID)) {
                           //platform.updateTempAndHumidity(idToCheck + "SWX", device.params);
                           platform.log("Thermostats coming soon");
                        }
                        
                        //************************//
                        // LIGHTS [SINGLE SWITCH] //
                        //************************//       
                        else if (platform.devicesLightbulb.includes(accessory.context.eweUIID) || platform.devicesSingleSwitchLight.includes(accessory.context.eweModel)) {
                           if (device.params.switch !== undefined) {
                              accessory.getService(Service.Lightbulb).updateCharacteristic(Characteristic.On, device.params.switch === 'on');
                              if (platform.devicesDimmable.includes(accessory.context.eweUIID)) {
                                 accessory.getService(Service.Lightbulb).updateCharacteristic(Characteristic.Brightness, device.params.bright);
                              }
                              if (platform.devicesColourable.includes(accessory.context.eweUIID)) {
                                 if (device.params.hasOwnProperty("colorR"))
                                 {
                                    let newColour = convert.rgb.hsl(device.params.colorR, device.params.colorG, device.params.colorB);
                                    accessory.getService(Service.Lightbulb).updateCharacteristic(Characteristic.Hue, newColour[0]);
                                    accessory.getService(Service.Lightbulb).updateCharacteristic(Characteristic.Saturation,  newColour[1]);
                                    accessory.getService(Service.Lightbulb).updateCharacteristic(Characteristic.Brightness,  newColour[2]);
                                 }
                                 else if (device.params.hasOwnProperty("bright"))
                                 {
                                    accessory.getService(Service.Lightbulb).updateCharacteristic(Characteristic.Brightness, device.params.bright);
                                 }
                              }
                           } else {
                              platform.log.error("[%s] Problem refreshing this device.", idToCheck + "SWX");
                              return;
                           }
                        }
                        
                        //***********************//
                        // LIGHTS [MULTI SWITCH] //
                        //***********************//
                        else if (platform.devicesMultiSwitch.includes(accessory.context.eweUIID) || platform.devicesMultiSwitchLight.includes(accessory.context.eweModel)) {
                           if (Array.isArray(device.params.switches)) {
                              let i;
                              let primaryState = false;
                              let otherAccessory;
                              for (i = 1; i <= accessory.context.channelCount; i++) {
                                 if (platform.devicesInHB.has(idToCheck + "SW" + i)) {
                                    otherAccessory = platform.devicesInHB.get(idToCheck + "SW" + i);
                                    if (platform.debug) platform.log("[%s] has been found in Homebridge so refresh status.", otherAccessory.displayName);
                                    otherAccessory.getService(Service.AccessoryInformation).setCharacteristic(Characteristic.FirmwareRevision, device.params.fwVersion);
                                    otherAccessory.getService(Service.Lightbulb).updateCharacteristic(Characteristic.On, device.params.switches[i - 1].switch === 'on');
                                    if (device.params.switches[i - 1].switch == 'on') primaryState = true;
                                 }
                                 accessory.getService(Service.Lightbulb).updateCharacteristic(Characteristic.On, primaryState);
                              }
                           } else {
                              platform.log.error("[%s] Problem refreshing this device.", idToCheck + "SW0");
                              return;
                           }
                        }
                        
                        //***********************//
                        // OTHER SINGLE SWITCHES //
                        //***********************//       
                        else if (platform.devicesSingleSwitch.includes(accessory.context.eweUIID)) {
                           if (device.params.switch !== undefined) {
                              accessory.getService(Service.Switch).updateCharacteristic(Characteristic.On, device.params.switch === 'on');
                           } else {
                              platform.log.error("[%s] Problem refreshing this device.", idToCheck + "SWX");                              
                           }
                        }
                        
                        //**********************//
                        // OTHER MULTI SWITCHES //
                        //**********************//
                        else if (platform.devicesMultiSwitch.includes(accessory.context.eweUIID)) { 
                           if (Array.isArray(device.params.switches)) {
                              let i;
                              let primaryState = false;
                              let otherAccessory;
                              for (i = 1; i <= accessory.context.channelCount; i++) {
                                 if (platform.devicesInHB.has(idToCheck + "SW" + i)) {
                                    otherAccessory = platform.devicesInHB.get(idToCheck + "SW" + i);
                                    if (platform.debug) platform.log("[%s] has been found in Homebridge so refresh status.", otherAccessory.displayName);
                                    otherAccessory.getService(Service.AccessoryInformation).setCharacteristic(Characteristic.FirmwareRevision, device.params.fwVersion);
                                    otherAccessory.getService(Service.Switch).updateCharacteristic(Characteristic.On, device.params.switches[i - 1].switch === 'on');
                                    if (device.params.switches[i - 1].switch == 'on') primaryState = true;
                                 }
                                 accessory.getService(Service.Switch).updateCharacteristic(Characteristic.On, primaryState);
                              }
                           } else {
                              platform.log.error("[%s] Problem refreshing this device.", idToCheck + "SW0");
                           }
                        }
                     } else {
                        if (platform.debug) platform.log.error("Accessory received via web socket does not exist in Homebridge. If it's a new accessory please try restarting Homebridge so it is added.");
                     }
                  } else if (device.action === 'sysmsg') {
                     
                     accessory = platform.devicesInHB.get(device.deviceid + "SWX");
                     accessory.reachable = device.online;
                     if (accessory.reachable) platform.log("[%s] has been reported online.", accessory.displayName);
                     else platform.log.error("[%s] has been reported offline.", accessory.displayName);
                     
                  } else {
                     if (platform.debug) platform.log.error("Unknown action property or no params received via web socket.");
                  }
               } else if (device.hasOwnProperty("config") && device.config.hb && device.config.hbInterval) {
                  if (!platform.hbInterval) {
                     platform.hbInterval = setInterval(function () {
                        platform.ws.send("ping");
                     }, device.config.hbInterval * 1000);
                  }
               } else {
                  if (platform.debug) platform.log.error("Unknown command received via web socket.");
               }
            };
            platform.ws.onclose = function (e) {
               if (platform.debug) platform.log("Web socket was closed [%s].", e);
               platform.webSocketOpen = false;
               if (platform.hbInterval) {
                  clearInterval(platform.hbInterval);
                  platform.hbInterval = null;
               }
            };
            // Get a list of all devices from eWeLink via the HTTP API, and compare it to the list of Homebridge cached devices (and then vice versa).
            // That is: new devices will be added, existing will be refreshed and those in the Homebridge cache but not in the web list will be removed.
            if (platform.debug) platform.log("Requesting a list of devices through the eWeLink HTTP API...");
            platform.webClient = request.createClient('https://' + platform.apiHost);
            platform.webClient.headers['Authorization'] = 'Bearer ' + platform.authenticationToken;
            platform.webClient.get('/api/user/device?' + platform.getArguments(platform.apiKey), function (err, res, body) {
               if (err) {
                  platform.log.error("An error occurred requesting devices through the API...");
                  platform.log.error("[%s].", err);
                  return;
               } else if (!body) {
                  platform.log.error("An error occurred requesting devices through the API...");
                  platform.log.error("[No data in response].");
                  return;
               } else if (body.hasOwnProperty('error') && body.error != 0) {
                  let response = JSON.stringify(body);
                  if (platform.debugReqRes) platform.log.warn(response);
                  platform.log.error("An error occurred requesting devices through the API...");
                  if (body.error === '401') {
                     platform.log.error("[Authorisation token error].");
                  } else {
                     platform.log.error("[%s].", response);
                  }
                  return;
               }
               let eWeLinkDevices = body.devicelist;
               
               let primaryDeviceCount = Object.keys(eWeLinkDevices).length;
               if (primaryDeviceCount === 0) {
                  platform.log("[0] primary devices were loaded from your eWeLink account. Devices will be removed from Homebridge.");
                  platform.api.unregisterPlatformAccessories("homebridge-eWeLink", "eWeLink", Array.from(platform.devicesInHB.values()));
                  platform.devicesInHB.clear();
                  return;
               }
               
               // The eWeLink devices are stored in the "platform.devicesInEwe" map with the device ID as the key (without the SW*) part.
               if (platform.debugInitial) platform.log.warn(JSON.stringify(eWeLinkDevices, null, 2));
               // The above is commented out because it takes up quite a large part of the log if you have a log of devices.
               eWeLinkDevices.forEach((device) => {
                  if (!platform.devicesUnsupported.includes(device.uiid)) {
                     platform.devicesInEwe.set(device.deviceid, device);
                  }
               });
               
               // Blind groupings found in the configuration are set in the "platform.deviceGroups" map.
               if (platform.config['groups'] && Object.keys(platform.config['groups']).length > 0) {
                  platform.config.groups.forEach((group) => {
                     if (typeof group.deviceId !== 'undefined' && platform.devicesInEwe.has(group.deviceId + "SWX")) {
                        platform.deviceGroups.set(group.deviceId + "SWX", group);
                     }
                  });
               }
               
               platform.log("[%s] primary devices were loaded from your eWeLink account.", primaryDeviceCount);
               platform.log("[%s] groups were loaded from the Homebridge configuration.", platform.deviceGroups.size);
               
               if (platform.debug) platform.log("Checking if devices need to be removed from the Homebridge cache.");
               // Here we check that each accessory in the Homebridge cache does in fact appear in the API response
               // ie each device in "platform.devicesInHB" exists in "platform.devicesInEwe"
               if (platform.devicesInHB.size > 0) {
                  platform.devicesInHB.forEach((accessory) => {
                     let hbDeviceId = accessory.context.hbDeviceId;
                     let idToCheck = accessory.context.eweDeviceId;
                     
                     if (!platform.devicesInEwe.has(idToCheck)) {
                        // The cached device wasn't found in the eWeLink response so remove.
                        if (platform.debug) platform.log('[%s] was not present in the API response so removing from Homebridge.', accessory.displayName);
                        platform.removeAccessory(accessory);
                     }
                  });
               }
               
               if (platform.debug) platform.log("Checking if devices need to be added/refreshed in the Homebridge cache.");
               // Now the reverse. Checking that each device from the API exists in Homebridge, otherwise we will add it to Homebridge.
               // ie each device in "platform.devicesInEwe" exists in "platform.devicesInHB"
               if (platform.devicesInEwe.size > 0) {
                  platform.devicesInEwe.forEach((device) => {
                     let services = {};
                     let accessory;
                     let idToCheck = device.deviceid;
                     let group;
                     
                     //**************************//
                     // ADD NON EXISTING DEVICES //
                     //**************************//
                     if (!platform.devicesInHB.has(idToCheck + "SWX") && !platform.devicesInHB.has(idToCheck + "SW0")) {
                        
                        //********//
                        // BLINDS //
                        //********//
                        if (platform.deviceGroups.has(idToCheck)) {
                           group = platform.deviceGroups.get(idToCheck);
                           if (group.type == 'blind' && Array.isArray(device.params.switches)) {
                              services.blind = true;
                              services.group = group;
                              platform.addAccessory(device, idToCheck + "SWX", services);
                           } else {
                              platform.log.error("[%s] Problem adding this device.", idToCheck + "SWX");
                              return;
                           }
                        }
                        
                        //******//
                        // FANS //
                        //******//                                  
                        else if (platform.devicesFan.includes(device.uiid)) {
                           if (Array.isArray(device.params.switches)) {
                              services.fan = true;
                              platform.addAccessory(device, idToCheck + "SWX", services);
                           } else {
                              platform.log.error("[%s] Problem adding this device.", idToCheck + "SWX");
                              return;
                           }
                        }
                        
                        //*************//
                        // THERMOSTATS //
                        //*************//                                                                              
                        else if (platform.devicesThermostat.includes(device.uiid)) {
                           services.thermostat = true;
                           platform.addAccessory(device, idToCheck + "SWX", services);
                        }
                        
                        //************************//
                        // LIGHTS [SINGLE SWITCH] //
                        //************************//
                        else if (platform.devicesLightbulb.includes(device.uiid) || platform.devicesSingleSwitchLight.includes(device.productModel)) {
                           if (device.params.switch !== undefined) {
                              services.lightbulb = true;
                              if (platform.devicesDimmable.includes(device.uiid)) services.dimmable = true;
                              if (platform.devicesColourable.includes(device.uiid)) services.colourable = true;
                              platform.addAccessory(device, idToCheck + "SWX", services);
                           } else {
                              platform.log.error("[%s] Problem adding this device.", idToCheck + "SWX");
                              return;
                           }
                        }
                        
                        //***********************//
                        // LIGHTS [MULTI SWITCH] //
                        //***********************//
                        else if (platform.devicesLightbulb.includes(device.uiid) || platform.devicesMultiSwitchLight.includes(device.productModel)) {   
                           if (Array.isArray(device.params.switches)) {
                              services.lightbulb = true;
                              channelCount = platform.getChannelsByUIID(device.uiid);
                              for (i = 0; i <= channelCount; i++) {
                                 platform.addAccessory(device, idToCheck + "SW" + i, services);
                              }
                           } else {
                              platform.log.error("[%s] Problem adding this device.", idToCheck + "SW0");
                              return;
                           }
                        }
                        
                        //***********************//
                        // OTHER SINGLE SWITCHES //
                        //***********************//          
                        else if (platform.devicesSingleSwitch.includes(device.uiid)) { 
                           if (device.params.switch !== undefined) {
                              services.switch = true;
                              platform.addAccessory(device, idToCheck + "SWX", services);
                           } else {
                              platform.log.error("[%s] Problem adding this device.", idToCheck + "SWX");
                           }
                        }
                        
                        //**********************//
                        // OTHER MULTI SWITCHES //
                        //**********************//
                        else if (platform.devicesMultiSwitch.includes(device.uiid)) { 
                           if (Array.isArray(device.params.switches)) {
                              services.switch = true;
                              channelCount = platform.getChannelsByUIID(device.uiid);
                              for (i = 0; i <= channelCount; i++) {
                                 platform.addAccessory(device, idToCheck + "SW" + i, services);
                              }
                           } else {
                              platform.log.error("[%s] Problem adding this device.", idToCheck + "SW0");
                           }
                        }
                        else platform.log("[%s] is not currently compatible with this plugin.", device.name);
                     }
                     
                     //*****************************************//
                     // REFRESH EXISTING AND JUST ADDED DEVICES //
                     //*****************************************//
                     if (platform.devicesInHB.has(idToCheck + "SWX") || platform.devicesInHB.has(idToCheck + "SW0")) {
                        if (platform.devicesInHB.has(idToCheck + "SWX")) accessory = platform.devicesInHB.get(idToCheck + "SWX");
                        else accessory = platform.devicesInHB.get(idToCheck + "SW0");
                        if (!device.online) {
                           platform.log.warn("[%s] has been reported offline so cannot refresh.", accessory.displayName);
                           return;
                        }
                        if (platform.debug) platform.log("[%s] has been found in Homebridge so refresh status.", accessory.displayName);
                        
                        accessory.getService(Service.AccessoryInformation).setCharacteristic(Characteristic.FirmwareRevision, device.params.fwVersion);
                        accessory.reachable = true;
                        
                        //********//
                        // BLINDS //
                        //********//       
                        if (platform.deviceGroups.has(idToCheck + "SWX")) {
                           group = platform.deviceGroups.get(idToCheck + "SWX");
                           if (group.type === "blind" && Array.isArray(device.params)) {
                              platform.externalBlindUpdate(idToCheck + "SWX", device.params);
                           } else {
                              platform.log.error("[%s] Problem refreshing this device.", idToCheck + "SWX");
                              return;
                           }
                        }
                        
                        //******//
                        // FANS //
                        //******//                                          
                        else if (platform.devicesFan.includes(accessory.context.eweUIID)) {
                           if (Array.isArray(device.params.switches)) {
                              accessory.getService(Service.Lightbulb).updateCharacteristic(Characteristic.On, device.params.switches[0].switch === 'on');
                              let status = false;
                              let speed = 0;
                              if (device.params.switches[1].switch == 'on' && device.params.switches[2].switch == 'off' && device.params.switches[3].switch == 'off') {
                                 status = true;
                                 speed = 33;
                              } else if (device.params.switches[1].switch == 'on' && device.params.switches[2].switch == 'on' && device.params.switches[3].switch == 'off') {
                                 status = true;
                                 speed = 66;
                              } else if (device.params.switches[1].switch == 'on' && device.params.switches[2].switch == 'off' && device.params.switches[3].switch == 'on') {
                                 status = true;
                                 speed = 100;
                              }
                              accessory.getService(Service.Fanv2).updateCharacteristic(Characteristic.On, status);
                              accessory.getService(Service.Fanv2).updateCharacteristic(Characteristic.RotationSpeed, speed);
                           } else {
                              platform.log.error("[%s] Problem refreshing this device.", idToCheck + "SWX");
                              return;
                           }
                        }
                        
                        //*************//
                        // THERMOSTATS //
                        //*************//                                    
                        else if (platform.devicesThermostat.includes(accessory.context.eweUIID)) {
                           //platform.updateTempAndHumidity(idToCheck + "SWX", device.params);
                           platform.log("Thermostats coming soon");
                        }
                        
                        //************************//
                        // LIGHTS [SINGLE SWITCH] //
                        //************************//       
                        else if (platform.devicesLightbulb.includes(accessory.context.eweUIID) || platform.devicesSingleSwitchLight.includes(accessory.context.eweModel)) {
                           if (device.params.switch !== undefined) {
                              accessory.getService(Service.Lightbulb).updateCharacteristic(Characteristic.On, device.params.switch === 'on');
                              if (platform.devicesDimmable.includes(accessory.context.eweUIID)) {
                                 accessory.getService(Service.Lightbulb).updateCharacteristic(Characteristic.Brightness, device.params.bright);
                              }
                              if (platform.devicesColourable.includes(accessory.context.eweUIID)) {
                                 let newColour = convert.rgb.hsl(device.params.colorR, device.params.colorG, device.params.colorB);
                                 accessory.getService(Service.Lightbulb).updateCharacteristic(Characteristic.Hue, newColour[0]);
                                 accessory.getService(Service.Lightbulb).updateCharacteristic(Characteristic.Saturation,  newColour[1]);
                                 accessory.getService(Service.Lightbulb).updateCharacteristic(Characteristic.Brightness,  newColour[2]);
                              }
                           } else {
                              platform.log.error("[%s] Problem refreshing this device.", idToCheck + "SWX");
                              return;
                           }
                        }
                        
                        //***********************//
                        // LIGHTS [MULTI SWITCH] //
                        //***********************//
                        else if (platform.devicesMultiSwitch.includes(accessory.context.eweUIID) || platform.devicesMultiSwitchLight.includes(accessory.context.eweModel)) {  
                           if (Array.isArray(device.params.switches)) {
                              let i;
                              let primaryState = false;
                              let otherAccessory;
                              for (i = 1; i <= accessory.context.channelCount; i++) {
                                 if (platform.devicesInHB.has(idToCheck + "SW" + i)) {
                                    otherAccessory = platform.devicesInHB.get(idToCheck + "SW" + i);
                                    if (platform.debug) platform.log("[%s] has been found in Homebridge so refresh status.", otherAccessory.displayName);
                                    otherAccessory.getService(Service.AccessoryInformation).setCharacteristic(Characteristic.FirmwareRevision, device.params.fwVersion);
                                    otherAccessory.reachable = true;
                                    otherAccessory.getService(Service.Lightbulb).updateCharacteristic(Characteristic.On, device.params.switches[i - 1].switch === 'on');
                                    if (device.params.switches[i - 1].switch == 'on') primaryState = true;
                                 }
                                 accessory.getService(Service.Lightbulb).updateCharacteristic(Characteristic.On, primaryState);
                              }
                           } else {
                              platform.log.error("[%s] Problem refreshing this device.", idToCheck + "SW0");
                           }
                        }
                        
                        //***********************//
                        // OTHER SINGLE SWITCHES //
                        //***********************//       
                        else if (platform.devicesSingleSwitch.includes(accessory.context.eweUIID)) {  
                           if (device.params.switch !== undefined) {
                              accessory.getService(Service.Switch).updateCharacteristic(Characteristic.On, device.params.switch === 'on');
                           } else {
                              platform.log.error("[%s] Problem refreshing this device.", idToCheck + "SWX");                              
                           }
                        }
                        
                        //**********************//
                        // OTHER MULTI SWITCHES //
                        //**********************//
                        else if (platform.devicesMultiSwitch.includes(accessory.context.eweUIID)) {  
                           if (Array.isArray(device.params.switches)) {
                              let i;
                              let primaryState = false;
                              let otherAccessory;
                              for (i = 1; i <= accessory.context.channelCount; i++) {
                                 if (platform.devicesInHB.has(idToCheck + "SW" + i)) {
                                    otherAccessory = platform.devicesInHB.get(idToCheck + "SW" + i);
                                    if (platform.debug) platform.log("[%s] has been found in Homebridge so refresh status.", otherAccessory.displayName);
                                    otherAccessory.getService(Service.AccessoryInformation).setCharacteristic(Characteristic.FirmwareRevision, device.params.fwVersion);
                                    otherAccessory.reachable = true;
                                    otherAccessory.getService(Service.Switch).updateCharacteristic(Characteristic.On, device.params.switches[i - 1].switch === 'on');
                                    if (device.params.switches[i - 1].switch == 'on') primaryState = true;
                                 }
                                 accessory.getService(Service.Switch).updateCharacteristic(Characteristic.On, primaryState);
                              }
                           } else {
                              platform.log.error("[%s] Problem refreshing this device.", idToCheck + "SW0");    
                           }
                        }
                     }
                  });
               }
               platform.log("Plugin initialisation has been successful.");
            });
         };
         this.getRegion(this.config['countryCode'], function () {
            this.login(afterLogin.bind(this));
         }.bind(this));
      }.bind(this));
   }
}

eWeLink.prototype.addAccessory = function (device, hbDeviceId, services) {
   let platform = this;
   if (!platform.log) {
      return;
   }
   if (platform.devicesInHB.get(hbDeviceId)) {
      platform.log("[%s] has not been added as it already exists in Homebridge.", hbDeviceId);
      return;
   }
   if (device.type != 10) {
      platform.log.warn("[%s] is not currently compatible with this plugin.", hbDeviceId);
      return;
   }
   
   let channelCount = platform.getChannelsByUIID(device.uiid);
   let switchNumber = hbDeviceId.substr(-1);
   
   if (switchNumber > channelCount) {
      platform.log.warn("[%s] has not been added as the [%s] only has [%s] switches.", newDeviceName, device.productModel, channelCount);
      return;
   }
   
   let status;
   let newDeviceName;
   
   switch (switchNumber) {
      case "X":
      status = device.params.switch;
      newDeviceName = device.name;
      break;
      case "0":
      status = (device.params.switches[0].switch == 'on' || device.params.switches[1].switch == 'on' || device.params.switches[2].switch == 'on' || device.params.switches[3].switch == 'on') ? 'on' : 'off';
      newDeviceName = device.name;
      break;
      case "1":
      case "2":
      case "3":
      case "4":
      newDeviceName = device.name + " SW" + switchNumber;
      status = device.params.switches[parseInt(switchNumber) - 1].switch;
      break;
   }
   
   const accessory = new Accessory(newDeviceName, UUIDGen.generate(hbDeviceId).toString());
   
   accessory.context.hbDeviceId = hbDeviceId;
   accessory.context.eweDeviceId = hbDeviceId.slice(0, -3);
   accessory.context.eweUIID = device.uiid;
   accessory.context.eweModel = device.productModel;
   accessory.context.eweApiKey = device.apikey;
   accessory.context.switchNumber = switchNumber;
   accessory.context.isDimmable = false;
   accessory.context.isColourable = false;
   accessory.context.isFan = false;
   accessory.context.channelCount = channelCount;
   accessory.reachable = device.online;
   
   accessory.on('identify', function (paired, callback) {
      platform.log("[%s] identified. Identification on device not supported.", accessory.displayName);
      try {
         callback();
      } catch (e) {}
   });
   if (services.switch) {
      accessory.addService(Service.Switch, newDeviceName).getCharacteristic(Characteristic.On)
      .on('set', function (value, callback) {
         platform.internalSwitchUpdate(accessory, value, callback);
      });
   }
   if (services.lightbulb) {
      accessory.addService(Service.Lightbulb, newDeviceName).getCharacteristic(Characteristic.On)
      .on('set', function (value, callback) {
         platform.internalLightbulbUpdate(accessory, value, callback);
      });
   }
   
   if (services.dimmable) {
      accessory.context.isDimmable = true;
      accessory.getService(Service.Lightbulb, newDeviceName).getCharacteristic(Characteristic.Brightness)
      .on('set', function (value, callback) {
         platform.internalBrightnessUpdate(accessory, value, callback);
      });
   }
   
   if (services.colourable) {
      accessory.context.isColourable = true;
      accessory.getService(Service.Lightbulb, newDeviceName).getCharacteristic(Characteristic.Hue)
      .on('set', function (value, callback) {
         platform.internalHSLUpdate(accessory, 'hue', value, callback);
      });
      accessory.getService(Service.Lightbulb, newDeviceName).getCharacteristic(Characteristic.Saturation)
      .on('set', function (value, callback) {
         platform.internalHSLUpdate(accessory, 'saturaton', value, callback);
      });
      accessory.getService(Service.Lightbulb, newDeviceName).getCharacteristic(Characteristic.Brightness)
      .on('set', function (value, callback) {
         platform.internalHSLUpdate(accessory, 'brightness', value, callback);
      });
   }
   
   if (services.fan) {
      accessory.context.isFan = true;
      accessory.addService(Service.Fanv2, newDeviceName).getCharacteristic(Characteristic.Active);
      accessory.getService(Service.Fanv2, newDeviceName).getCharacteristic(Characteristic.On)
      .on("set", function (value, callback) {
         platform.internalFanUpdate(accessory, 'power', value, callback);
      });
      accessory.getService(Service.Fanv2, newDeviceName).getCharacteristic(Characteristic.RotationSpeed)
      .setProps({
         minStep: 3
      })
      .on("set", function (value, callback) {
         platform.internalFanUpdate(accessory, 'speed', value, callback);
      });
      accessory.addService(Service.Lightbulb, newDeviceName).getCharacteristic(Characteristic.On)
      .on('set', function (value, callback) {
         platform.internalFanUpdate(accessory, 'light', value, callback);
      });
   }
   if (services.thermostat) {
      accessory.addService(Service.Thermostat, newDeviceName).getCharacteristic(Characteristic.CurrentHeatingCoolingState);
      accessory.getService(Service.Thermostat, newDeviceName).getCharacteristic(Characteristic.TargetHeatingCoolingState);
      accessory.getService(Service.Thermostat, newDeviceName).getCharacteristic(Characteristic.CurrentTemperature);
      accessory.getService(Service.Thermostat, newDeviceName).getCharacteristic(Characteristic.TargetTemperature);
      accessory.getService(Service.Thermostat, newDeviceName).getCharacteristic(Characteristic.TemperatureDisplayUnits);
      accessory.getService(Service.Thermostat, newDeviceName).getCharacteristic(Characteristic.CoolingThresholdTemperature);
      accessory.getService(Service.Thermostat, newDeviceName).getCharacteristic(Characteristic.CurrentRelativeHumidity);
      accessory.getService(Service.Thermostat, newDeviceName).getCharacteristic(Characteristic.HeatingThresholdTemperature);
      accessory.getService(Service.Thermostat, newDeviceName).getCharacteristic(Characteristic.TargetRelativeHumidity);
   }
   
   if (services.blind) {
      accessory.context.switchUp = (services.group.switchUp || platform.groupDefaults['switchUp']) - 1;
      accessory.context.switchDown = (services.group.switchDown || platform.groupDefaults['switchDown']) - 1;
      accessory.context.durationUp = services.group.timeUp || platform.groupDefaults['timeUp'];
      accessory.context.durationDown = services.group.timeDown || platform.groupDefaults['timeDown'];
      accessory.context.durationBMU = services.group.timeBottomMarginUp || platform.groupDefaults['timeBottomMarginUp'];
      accessory.context.durationBMD = services.group.timeBottomMarginDown || platform.groupDefaults['timeBottomMarginDown'];
      accessory.context.fullOverdrive = services.group.fullOverdrive || platform.groupDefaults['fullOverdrive'];
      accessory.context.percentDurationDown = accessory.context.durationDown * 10;
      accessory.context.percentDurationUp = accessory.context.durationUp * 10;
      accessory.context.lastPosition = 100; // Last known position (0-100%).
      accessory.context.currentPositionState = 2; // 0 = Moving up, 1 = Moving down, 2 = Not moving.
      accessory.context.currentTargetPosition = 100; // Target position (0-100%).
      
      accessory.addService(Service.WindowCovering, newDeviceName).getCharacteristic(Characteristic.CurrentPosition)
      .on('get', function (callback) {
         platform.getBlindPosition(accessory, callback);
      });
      accessory.getService(Service.WindowCovering, newDeviceName).getCharacteristic(Characteristic.PositionState)
      .on('get', function (callback) {
         platform.getBlindMovementState(accessory, callback);
      });
      accessory.getService(Service.WindowCovering, newDeviceName).getCharacteristic(Characteristic.TargetPosition)
      .on('get', function (callback) {
         platform.getBlindTargetPosition(accessory, callback);
      })
      .on('set', function (value, callback) {
         platform.setBlindTargetPosition(accessory, value, callback);
      });
   }
   
   try {
      accessory.getService(Service.AccessoryInformation).setCharacteristic(Characteristic.SerialNumber, hbDeviceId);
      accessory.getService(Service.AccessoryInformation).setCharacteristic(Characteristic.Manufacturer, device.brandName);
      accessory.getService(Service.AccessoryInformation).setCharacteristic(Characteristic.Model, device.productModel + ' (' + device.extra.extra.model + ')');
      accessory.getService(Service.AccessoryInformation).setCharacteristic(Characteristic.Identify, false);
      accessory.getService(Service.AccessoryInformation).setCharacteristic(Characteristic.FirmwareRevision, device.params.fwVersion);
   } catch (e) {
      platform.log.error("[%s] has not been added [%s].", accessory.displayName, e);
   }
   
   platform.devicesInHB.set(hbDeviceId, accessory);
   platform.api.registerPlatformAccessories("homebridge-eWeLink", "eWeLink", [accessory]);
   if (platform.debug) platform.log("[%s] has been added which is currently [%s].", newDeviceName, status);
};

eWeLink.prototype.configureAccessory = function (accessory) {
   let platform = this;
   if (!platform.log) {
      return;
   }
   
   if (accessory.getService(Service.Switch)) {
      accessory.getService(Service.Switch).getCharacteristic(Characteristic.On)
      .on('set', function (value, callback) {
         platform.internalSwitchUpdate(accessory, value, callback);
      });
   }
   if (accessory.getService(Service.Lightbulb) && !accessory.context.isFan) {
      accessory.getService(Service.Lightbulb).getCharacteristic(Characteristic.On)
      .on('set', function (value, callback) {
         platform.internalLightbulbUpdate(accessory, value, callback);
      });
      if (accessory.context.isDimmable) {
         accessory.getService(Service.Lightbulb).getCharacteristic(Characteristic.Brightness)
         .on('set', function (value, callback) {
            platform.internalBrightnessUpdate(accessory, value, callback);
         });
      }
      if (accessory.context.isColourable) {
         accessory.getService(Service.Lightbulb).getCharacteristic(Characteristic.Hue)
         .on('set', function (value, callback) {
            platform.internalHSLUpdate(accessory, 'hue', value, callback);
         });
         accessory.getService(Service.Lightbulb).getCharacteristic(Characteristic.Saturation)
         .on('set', function (value, callback) {
            platform.internalHSLUpdate(accessory, 'saturation', value, callback);
         });
         accessory.getService(Service.Lightbulb).getCharacteristic(Characteristic.Brightness)
         .on('set', function (value, callback) {
            platform.internalHSLUpdate(accessory, 'brightness', value, callback);
         });      
      }
   }
   if (accessory.getService(Service.Fanv2)) {
      accessory.getService(Service.Fanv2, newDeviceName).getCharacteristic(Characteristic.Active).updateValue("1");
      accessory.getService(Service.Fanv2).getCharacteristic(Characteristic.On)
      .on("set", function (value, callback) {
         platform.internalFanUpdate(accessory, 'power', value, callback);
      });
      accessory.getService(Service.Fanv2).getCharacteristic(Characteristic.RotationSpeed)
      .setProps({minStep: 3})
      .on("set", function (value, callback) {
         platform.internalFanUpdate(accessory, 'speed', value, callback);
      });
   }
   if (accessory.getService(Service.Lightbulb) && accessory.context.isFan) {
      accessory.getService(Service.Lightbulb).getCharacteristic(Characteristic.On)
      .on('set', function (value, callback) {
         platform.internalFanUpdate(accessory, 'light', value, callback);
      });
   }
   if (accessory.getService(Service.Thermostat)) {
      accessory.getService(Service.Thermostat, newDeviceName).getCharacteristic(Characteristic.CurrentHeatingCoolingState);
      accessory.getService(Service.Thermostat, newDeviceName).getCharacteristic(Characteristic.TargetHeatingCoolingState);
      accessory.getService(Service.Thermostat, newDeviceName).getCharacteristic(Characteristic.CurrentTemperature);
      accessory.getService(Service.Thermostat, newDeviceName).getCharacteristic(Characteristic.TargetTemperature);
      accessory.getService(Service.Thermostat, newDeviceName).getCharacteristic(Characteristic.TemperatureDisplayUnits);
      accessory.getService(Service.Thermostat, newDeviceName).getCharacteristic(Characteristic.CoolingThresholdTemperature);
      accessory.getService(Service.Thermostat, newDeviceName).getCharacteristic(Characteristic.CurrentRelativeHumidity);
      accessory.getService(Service.Thermostat, newDeviceName).getCharacteristic(Characteristic.HeatingThresholdTemperature);
      accessory.getService(Service.Thermostat, newDeviceName).getCharacteristic(Characteristic.TargetRelativeHumidity);
   }
   
   if (accessory.getService(Service.WindowCovering)) {
      accessory.getService(Service.WindowCovering).getCharacteristic(Characteristic.TargetPosition)
      .on('set', function (value, callback) {
         platform.setBlindTargetPosition(accessory, value, callback);
      });
      
      let payload = {};
      payload.action = 'update';
      payload.userAgent = 'app';
      payload.params = {
         "lock": 0,
         "zyx_clear_timers": false,
         "configure":[{"startup":"off","outlet":0},{"startup":"off","outlet":1},{"startup":"off","outlet": 2},{"startup":"off", "outlet": 3}],
         "pulses":[{"pulse":"off","width":1000,"outlet":0},{"pulse":"off","width":1000,"outlet":1},{"pulse":"off","width":1000,"outlet":2},{"pulse":"off","width":1000,"outlet":3}],
         "switches":[{"switch":"off","outlet": 0},{"switch":"off","outlet":1},{"switch":"off","outlet": 2},{"switch": "off","outlet":3}]
      };
      payload.apikey = accessory.context.eweApiKey;
      payload.deviceid = accessory.context.eweDeviceId;
      payload.sequence = platform.getSequence();
      
      let string = JSON.stringify(payload);
      if (platform.debugReqRes) platform.log.warn(payload);
      platform.sendWebSocketMessage(string, function () {
         return;
      });
      if (platform.debug) platform.log("[%s] initialising switches for correct start up.", accessory.displayName);
      
      
      let lastPosition = accessory.context.lastPosition;
      if ((lastPosition === undefined) || (lastPosition < 0)) lastPosition = 0;
      if (platform.debug) platform.log("[%s] cached position was [%s].", accessory.displayName, lastPosition);
      accessory.context.lastPosition = lastPosition;
      accessory.context.currentTargetPosition = lastPosition;
      accessory.context.currentPositionState = 2; // 0 = Moving up, 1 = Moving down, 2 = Not moving.
      
      let group = platform.deviceGroups.get(accessory.context.hbDeviceId);
      if (group) {
         accessory.context.switchUp = (group.switchUp || platform.groupDefaults['switchUp']) - 1;
         accessory.context.switchDown = (group.switchDown || platform.groupDefaults['switchDown']) - 1;
         accessory.context.durationUp = group.timeUp || platform.groupDefaults['timeUp'];
         accessory.context.durationDown = group.timeDown || platform.groupDefaults['timeDown'];
         accessory.context.durationBMU = group.timeBottomMarginUp || platform.groupDefaults['timeBottomMarginUp'];
         accessory.context.durationBMD = group.timeBottomMarginDown || platform.groupDefaults['timeBottomMarginDown'];
         accessory.context.fullOverdrive = platform.groupDefaults['fullOverdrive'];
         accessory.context.percentDurationDown = accessory.context.durationDown * 10;
         accessory.context.percentDurationUp = accessory.context.durationUp * 10;
      }
   }
   platform.devicesInHB.set(accessory.context.hbDeviceId, accessory);
};

eWeLink.prototype.removeAccessory = function (accessory) {
   let platform = this;
   if (!platform.log) {
      return;
   }
   platform.devicesInHB.delete(accessory.context.hbDeviceId);
   platform.api.unregisterPlatformAccessories('homebridge-eWeLink', 'eWeLink', [accessory]);
   if (platform.debug) platform.log("[%s] has been removed from Homebridge.", accessory.displayName);
};

eWeLink.prototype.internalSwitchUpdate = function (accessory, isOn, callback) {
   let platform = this;
   if (!platform.log) {
      return;
   }
   if (!accessory.reachable) {
      platform.log.error("[%s] is currently offline so cannot be updated.", accessory.displayName);
      return;
   }
   
   let targetState = isOn ? 'on' : 'off';
   let otherAccessory;
   let i;
   let payload = {};
   
   payload.action = 'update';
   payload.userAgent = 'app';
   payload.params = {};
   payload.apikey = accessory.context.eweApiKey;
   payload.deviceid = accessory.context.eweDeviceId;
   payload.sequence = platform.getSequence();
   
   switch (accessory.context.switchNumber) {
      case "X":
      if (platform.debug) platform.log("[%s] requesting to turn [%s].", accessory.displayName, targetState);
      payload.params.switch = targetState;
      accessory.getService(Service.Switch).updateCharacteristic(Characteristic.On, isOn);
      break;
      case "0":
      if (platform.debug) platform.log("[%s] requesting to turn [%s].", accessory.displayName, targetState);
      payload.params.switches = platform.devicesInEwe.get(accessory.context.eweDeviceId).params.switches;
      payload.params.switches[0].switch = targetState;
      payload.params.switches[1].switch = targetState;
      payload.params.switches[2].switch = targetState;
      payload.params.switches[3].switch = targetState;
      accessory.getService(Service.Switch).updateCharacteristic(Characteristic.On, isOn);
      for (i = 1; i <= 4; i++) {
         if (platform.devicesInHB.has(accessory.context.eweDeviceId + "SW" + i)) {
            otherAccessory = platform.devicesInHB.get(accessory.context.eweDeviceId + "SW" + i);
            if (platform.debug) platform.log("[%s] requesting to turn [%s].", otherAccessory.displayName, targetState);
            otherAccessory.getService(Service.Switch).updateCharacteristic(Characteristic.On, isOn);
         }
      }
      break;
      case "1":
      case "2":
      case "3":
      case "4":
      if (platform.debug) platform.log("[%s] requesting to turn [%s].", accessory.displayName, targetState);
      payload.params.switches = platform.devicesInEwe.get(accessory.context.eweDeviceId).params.switches;
      payload.params.switches[parseInt(accessory.context.switchNumber) - 1].switch = targetState;
      accessory.getService(Service.Switch).updateCharacteristic(Characteristic.On, isOn);   
      let ch;
      let masterState = "off";
      for (i = 1; i <= 4; i++) {
         if (platform.devicesInHB.has(accessory.context.eweDeviceId + "SW" + i)) {
            ch = platform.devicesInHB.get(accessory.context.eweDeviceId + "SW" + i).getService(Service.Switch).getCharacteristic(Characteristic.On).value;
            if (ch) {
               masterState = "on";
            }
         }
      }
      
      otherAccessory = platform.devicesInHB.get(accessory.context.eweDeviceId + "SW0");
      if (platform.debug) platform.log("[%s] requesting to turn [%s].", otherAccessory.displayName, masterState);
      otherAccessory.getService(Service.Switch).updateCharacteristic(Characteristic.On, masterState == 'on' ? true : false);
      break;
   }
   let string = JSON.stringify(payload);
   platform.sendWebSocketMessage(string, callback);
};

eWeLink.prototype.internalLightbulbUpdate = function (accessory, isOn, callback) {
   let platform = this;
   if (!platform.log) {
      return;
   }
   if (!accessory.reachable) {
      platform.log.error("[%s] is currently offline so cannot be updated.", accessory.displayName);
      return;
   }
   
   let targetState = isOn ? 'on' : 'off';
   let otherAccessory;
   let i;
   let payload = {};
   
   payload.action = 'update';
   payload.userAgent = 'app';
   payload.params = {};
   payload.apikey = accessory.context.eweApiKey;
   payload.deviceid = accessory.context.eweDeviceId;
   payload.sequence = platform.getSequence();
   
   switch (accessory.context.switchNumber) {
      case "X":
      if (platform.debug) platform.log("[%s] requesting to turn [%s].", accessory.displayName, targetState);
      payload.params.switch = targetState;
      accessory.getService(Service.Lightbulb).updateCharacteristic(Characteristic.On, isOn);
      break;
      case "0":
      if (platform.debug) platform.log("[%s] requesting to turn [%s].", accessory.displayName, targetState);
      payload.params.switches = platform.devicesInEwe.get(accessory.context.eweDeviceId).params.switches;
      payload.params.switches[0].switch = targetState;
      payload.params.switches[1].switch = targetState;
      payload.params.switches[2].switch = targetState;
      payload.params.switches[3].switch = targetState;
      accessory.getService(Service.Lightbulb).updateCharacteristic(Characteristic.On, isOn);
      for (i = 1; i <= 4; i++) {
         if (platform.devicesInHB.has(accessory.context.eweDeviceId + "SW" + i)) {
            otherAccessory = platform.devicesInHB.get(accessory.context.eweDeviceId + "SW" + i);
            if (platform.debug) platform.log("[%s] requesting to turn [%s].", otherAccessory.displayName, targetState);
            otherAccessory.getService(Service.Lightbulb).updateCharacteristic(Characteristic.On, isOn);
         }
      }
      break;
      case "1":
      case "2":
      case "3":
      case "4":
      if (platform.debug) platform.log("[%s] requesting to turn [%s].", accessory.displayName, targetState);
      payload.params.switches = platform.devicesInEwe.get(accessory.context.eweDeviceId).params.switches;
      payload.params.switches[parseInt(accessory.context.switchNumber) - 1].switch = targetState;
      accessory.getService(Service.Lightbulb).updateCharacteristic(Characteristic.On, isOn);   
      let ch;
      let masterState = "off";
      for (i = 1; i <= 4; i++) {
         if (platform.devicesInHB.has(accessory.context.eweDeviceId + "SW" + i)) {
            ch = platform.devicesInHB.get(accessory.context.eweDeviceId + "SW" + i).getService(Service.Lightbulb).getCharacteristic(Characteristic.On).value;
            if (ch) {
               masterState = "on";
            }
         }
      }
      
      otherAccessory = platform.devicesInHB.get(accessory.context.eweDeviceId + "SW0");
      if (platform.debug) platform.log("[%s] requesting to turn [%s].", otherAccessory.displayName, masterState);
      otherAccessory.getService(Service.Lightbulb).updateCharacteristic(Characteristic.On, masterState == 'on' ? true : false);
      break;
   }
   let string = JSON.stringify(payload);
   platform.sendWebSocketMessage(string, callback);
};

eWeLink.prototype.internalBrightnessUpdate = function (accessory, targetBrightness, callback) {
   let platform = this;
   if (!platform.log) {
      return;
   }
   if (!accessory.reachable) {
      platform.log.error("[%s] is currently offline so cannot be updated.", accessory.displayName);
      return;
   }
   
   let otherAccessory;
   let i;
   let payload = {};
   
   payload.action = 'update';
   payload.userAgent = 'app';
   payload.params = {};
   payload.apikey = accessory.context.eweApiKey;
   payload.deviceid = accessory.context.eweDeviceId;
   payload.sequence = platform.getSequence();
   
   switch (accessory.context.switchNumber) {
      case "X":
      payload.params.bright = targetBrightness;
      accessory.getService(Service.Lightbulb).updateCharacteristic(Characteristic.Brightness, targetBrightness);
      accessory.getService(Service.Lightbulb).updateCharacteristic(Characteristic.On, targetBrightness != 0);
      break;
   }
   let string = JSON.stringify(payload);
   platform.sendWebSocketMessage(string, callback);
   if (platform.debug) platform.log("[%s] requesting to turn brightness to [%s%].", accessory.displayName, targetBrightness);
};

eWeLink.prototype.internalHSLUpdate = function (accessory, type, targetHSL, callback) {
   let platform = this;
   if (!platform.log) {
      return;
   }
   if (!accessory.reachable) {
      platform.log.error("[%s] is currently offline so cannot be updated.", accessory.displayName);
      return;
   }
   
   let newHue;
   let newSaturation;
   let newBrightness;
   switch (type) {
      case "hue":
      newHue = targetHSL;
      newSaturation = accessory.getService(Service.Lightbulb).getCharacteristic(Characteristic.Saturation).value;
      newBrightness = accessory.getService(Service.Lightbulb).getCharacteristic(Characteristic.Brightness).value;
      break;
      case "saturation":
      newHue = accessory.getService(Service.Lightbulb).getCharacteristic(Characteristic.Hue).value;
      newSaturation = targetHSL;
      newBrightness = accessory.getService(Service.Lightbulb).getCharacteristic(Characteristic.Brightness).value;
      break;
      case "brightness":
      newHue = accessory.getService(Service.Lightbulb).getCharacteristic(Characteristic.Hue).value;
      newSaturation = accessory.getService(Service.Lightbulb).getCharacteristic(Characteristic.Saturation).value;
      newBrightness = targetHSL;
      break;
   }
   
   let newColour = convert.hsl.rgb(newHue, newSaturation, newBrightness);
   let payload = {};  
   payload.action = 'update';
   payload.userAgent = 'app';
   payload.params = {};
   payload.apikey = accessory.context.eweApiKey;
   payload.deviceid = accessory.context.eweDeviceId;
   payload.sequence = platform.getSequence();
   
   switch (accessory.context.switchNumber) {
      case "X":
      payload.params.colorR = newColour[0];
      payload.params.colorG = newColour[1];
      payload.params.colorB = newColour[2];
      accessory.getService(Service.Lightbulb).updateCharacteristic(Characteristic.Hue, newHue);
      accessory.getService(Service.Lightbulb).updateCharacteristic(Characteristic.Saturation, newSaturation);
      accessory.getService(Service.Lightbulb).updateCharacteristic(Characteristic.Brightness, newBrightness);
      accessory.getService(Service.Lightbulb).updateCharacteristic(Characteristic.On, newColour[0] + newColour[1] + newColour[2] != 0);
      break;
   }
   let string = JSON.stringify(payload);
   platform.sendWebSocketMessage(string, callback);
   if (platform.debug) platform.log("[%s] requesting to turn HSL to [%s %s %s].", accessory.displayName, newHue, newSaturation, newBrightness);
};

eWeLink.prototype.internalFanUpdate = function (accessory, type, targetState, callback) {
   let platform = this;
   if (!platform.log) {
      return;
   }
   if (!accessory.reachable) {
      platform.log.error("[%s] is currently offline so cannot be updated.", accessory.displayName);
      return;
   }
   
   let newPower;
   let newSpeed;
   let newLight;
   
   switch (type) {
      case "power":
      newPower = targetState;
      newSpeed = targetState ? 33 : 0;
      newLight = accessory.getService(Service.Lightbulb).getCharacteristic(Characteristic.On).value;
      break;
      case "speed":
      newPower = targetState >= 33;
      newSpeed = targetState;
      newLight = accessory.getService(Service.Lightbulb).getCharacteristic(Characteristic.On).value;
      break;
      case "light":
      newPower = accessory.getService(Service.Fanv2).getCharacteristic(Characteristic.On).value;
      newSpeed = accessory.getService(Service.Fanv2).getCharacteristic(Characteristic.RotationSpeed).value;
      newLight = targetState;
      break;
   }
   
   switch (accessory.context.switchNumber) {
      case "X":
      accessory.getService(Service.Lightbulb).updateCharacteristic(Characteristic.On, newLight);
      accessory.getService(Service.Fanv2).updateCharacteristic(Characteristic.On, newPower);
      accessory.getService(Service.Fanv2).updateCharacteristic(Characteristic.RotationSpeed, newSpeed);
      break;
   }
   
   let payload = {};
   payload.params = {};
   payload.params.switches = platform.devicesInEwe.get(accessory.context.eweDeviceId).params.switches;
   payload.params.switches[0].switch = newLight ? "on" : "off";
   payload.params.switches[1].switch = newSpeed >= 33 ? "on" : "off";
   payload.params.switches[2].switch = newSpeed >= 66 && newSpeed < 99  ? "on" : "off";
   payload.params.switches[3].switch = newSpeed >= 99 ? "on" : "off";
   payload.action = 'update';
   payload.userAgent = 'app';
   payload.apikey = accessory.context.eweApiKey;
   payload.deviceid = accessory.context.eweDeviceId;
   payload.sequence = platform.getSequence();
   
   let string = JSON.stringify(payload);
   platform.sendWebSocketMessage(string, callback);
   if (platform.debug) platform.log("[%s] requesting to change fan %s.", accessory.displayName, type);
};


eWeLink.prototype.externalBlindUpdate = function (hbDeviceId, params) {
   let platform = this;
   if (!platform.log) {
      return;
   }
   
   let accessory = platform.devicesInHB.get(hbDeviceId);
   
   let switchUp = params.switches[accessory.context.switchUp].switch === 'on' ? 1 : 0;
   let switchDown = params.switches[accessory.context.switchDown].switch === 'on' ? 1 : 0;
   let sum = (switchUp * 2) + switchDown;
   
   // Sum can be:
   // [0,0] = 0 => 2 Stopped
   // [0,1] = 1 => 1 Moving down
   // [1,0] = 2 => 0 Moving up
   // [1,1] = 3 => 3 Error
   
   const MAPPING = {0: 2, 1: 1, 2: 0, 3: 3};
   let state = MAPPING[sum];
   
   let stateString = ["Moving up", "Moving down", "Stopped", "Error"];
   let actualPosition;
   
   if (state == 2 || state == 3) {
      let timestamp = Date.now();
      if (accessory.context.currentPositionState == 1) {
         actualPosition = Math.round(accessory.context.lastPosition - ((timestamp - accessory.context.startTimestamp) / accessory.context.percentDurationDown));
      } else if (accessory.context.currentPositionState == 0) {
         actualPosition = Math.round(accessory.context.lastPosition + ((timestamp - accessory.context.startTimestamp) / accessory.context.percentDurationUp));
      } else {
         actualPosition = accessory.context.lastPosition;
      }
   }
   
   switch (state) {
      case 3:
      platform.log("[%s] Error with current movement state so resetting.", accessory.displayName);
      accessory.context.currentTargetPosition = actualPosition;
      accessory.context.targetTimestamp = Date.now() + 10;
      accessory.getService(Service.WindowCovering).updateCharacteristic(Characteristic.TargetPosition, actualPosition);
      break;
      case 2:
      if (accessory.context.currentPositionState == 2) {
         platform.log("[%s] received request to stop moving. Nothing to do as blind is already stopped.", accessory.displayName);
         return;
      }
      platform.log("[%s] received request to stop moving. Updating new position [%s].", accessory.displayName, actualPosition);
      accessory.context.currentTargetPosition = actualPosition;
      accessory.context.targetTimestamp = Date.now() + 10;
      accessory.getService(Service.WindowCovering).updateCharacteristic(Characteristic.TargetPosition, actualPosition);
      break;
      case 1:
      if (accessory.context.currentPositionState == 1) {
         platform.log("[%s] received request to move down. Nothing to do as blind is already moving down.", accessory.displayName);
         return;
      }
      if (accessory.context.currentTargetPosition == 0) {
         platform.log("[%s] received request to move down but was already fully closing. Stopping.", accessory.displayName);
      } else {
         platform.log("[%s] received request to move down so setting target position to 0.", accessory.displayName);
         accessory.getService(Service.WindowCovering).updateCharacteristic(Characteristic.TargetPosition, 0);
      }
      break;
      case 0:
      if (accessory.context.currentPositionState == 0) {
         platform.log("[%s] received request to move up. Nothing to do as blind is already moving up.", accessory.displayName);
         return;
      }
      if (accessory.context.currentTargetPosition == 100) {
         platform.log("[%s] received request to move up but was already fully opening. Stopping.", accessory.displayName);
         
      } else {
         platform.log("[%s] received request to move up so setting target position to 100.", accessory.displayName);
         accessory.getService(Service.WindowCovering).updateCharacteristic(Characteristic.TargetPosition, 100);
      }
      break;
   }
   if ((state == 0 && accessory.context.currentTargetPosition == 0) || (state == 1 && accessory.context.currentTargetPosition == 100)) {
      accessory.context.currentPositionState = 2;
      
      
      platform.log("[%s] Request sent to stop moving.", accessory.displayName);
      
      let currentTargetPosition = accessory.context.currentTargetPosition;
      accessory.context.lastPosition = currentTargetPosition;
      accessory.getService(Service.WindowCovering).getCharacteristic(Characteristic.CurrentPosition).updateValue(currentTargetPosition);
      accessory.getService(Service.WindowCovering).getCharacteristic(Characteristic.TargetPosition).updateValue(currentTargetPosition);
      
      platform.log("[%s] Successfully moved to target position: %s", accessory.displayName, currentTargetPosition);
      
      let payload = platform.prepareBlindPayload(accessory);
      let string = JSON.stringify(payload);
      platform.sendWebSocketMessage(string, callback);
   } else {
      return;
   }
};


eWeLink.prototype.getSequence = function () {
   let time_stamp = new Date() / 1000;
   this.sequence = Math.floor(time_stamp * 1000);
   return this.sequence;
};

eWeLink.prototype.sendWebSocketMessage = function (string, callback) {
   let platform = this;
   if (!platform.log) {
      return;
   }
   platform.delaySend = 0;
   const delayOffset = 280;
   
   let sendOperation = function (string) {
      if (!platform.webSocketOpen) {
         setTimeout(function () {
            sendOperation(string);
         }, delayOffset);
         return;
      }
      
      if (platform.ws) {
         platform.ws.send(string);
         if (platform.debugReqRes && string !== "ping") platform.log.warn("Web socket message sent.\n" + JSON.stringify(JSON.parse(string), null, 2));
         else if (platform.debug && string !== "ping") platform.log("Web socket message sent.");
         callback();
      }
      
      if (platform.delaySend <= 0) {
         platform.delaySend = 0;
      } else {
         platform.delaySend -= delayOffset;
      }
   };
   
   if (!platform.webSocketOpen) {
      if (platform.debug) platform.log('Socket was closed. It will reconnect automatically.');
      let interval;
      let waitToSend = function (string) {
         if (platform.webSocketOpen) {
            clearInterval(interval);
            sendOperation(string);
         }
      };
      interval = setInterval(waitToSend, 750, string);
   } else {
      setTimeout(sendOperation, platform.delaySend, string);
      platform.delaySend += delayOffset;
   }
};

eWeLink.prototype.login = function (callback) {
   let platform = this;
   if (!platform.log) {
      return;
   }
   
   var data = {};
   if (platform.emailLogin) {
      data.email = platform.config.username;
   } else {
      data.phoneNumber = platform.config.username;
   }
   data.password = platform.config.password;
   data.version = 8;
   data.ts = Math.floor(new Date().getTime() / 1000);
   data.nonce = nonce();
   data.appid = platform.appid;
   
   if (platform.debugReqRes) platform.log.warn("Sending HTTPS login request.\n" + JSON.stringify(data, null, 2));
   else if (platform.debug) platform.log("Sending HTTPS login request.");
   
   let json = JSON.stringify(data);
   let sign = platform.getSignature(json);
   if (platform.debug) platform.log("Login signature [%s].", sign);
   let webClient = request.createClient('https://' + platform.apiHost);
   webClient.headers['Authorization'] = 'Sign ' + sign;
   webClient.headers['Content-Type'] = 'application/json;charset=UTF-8';
   webClient.post('/api/user/login', data, function (err, res, body) {
      if (err) {
         platform.log.error("An error occurred while logging in. [%s].", err);
         callback();
         return;
      }
      if (body.hasOwnProperty('error') && body.error == 301 && body.hasOwnProperty('region')) {
         let idx = platform.apiHost.indexOf('-');
         if (idx == -1) {
            platform.log.error("Received new region [%s]. However we cannot construct the new API host url.", body.region);
            callback();
            return;
         }
         let newApiHost = body.region + platform.apiHost.substring(idx);
         if (platform.apiHost != newApiHost) {
            if (platform.debug) platform.log("Received new region [%s], updating API host to [%s].", body.region, newApiHost);
            platform.apiHost = newApiHost;
            platform.login(callback);
            return;
         }
      }
      
      if (!body.at) {
         platform.log.error("Server did not response with an authentication token.");
         platform.log.warn("\n" + JSON.stringify(body, null, 2));
         callback();
         return;
      }
      platform.authenticationToken = body.at;
      platform.apiKey = body.user.apikey;
      platform.webClient = request.createClient('https://' + platform.apiHost);
      platform.webClient.headers['Authorization'] = 'Bearer ' + body.at;
      
      platform.getWebSocketHost(function () {
         callback(body.at);
      }.bind(this));
   }.bind(this));
};

eWeLink.prototype.getRegion = function (countryCode, callback) {
   let platform = this;
   if (!platform.log) {
      return;
   }
   var data = {};
   data.country_code = countryCode;
   data.version = 8;
   data.ts = Math.floor(new Date().getTime() / 1000);
   data.nonce = nonce();
   data.appid = platform.appid;
   
   let query = querystring.stringify(data);
   if (platform.debug) platform.log("Info: getRegion query [%s].", query);
   
   let dataToSign = [];
   Object.keys(data).forEach(function (key) {
      dataToSign.push({
         key: key,
         value: data[key]
      });
   });
   dataToSign.sort(function (a, b) {
      return a.key < b.key ? -1 : 1;
   });
   dataToSign = dataToSign.map(function (kv) {
      return kv.key + "=" + kv.value;
   }).join('&');
   
   let sign = platform.getSignature(dataToSign);
   if (platform.debug) platform.log("Info: getRegion signature [%s].", sign);
   
   let webClient = request.createClient('https://api.coolkit.cc:8080');
   webClient.headers['Authorization'] = 'Sign ' + sign;
   webClient.headers['Content-Type'] = 'application/json;charset=UTF-8';
   webClient.get('/api/user/region?' + query, function (err, res, body) {
      if (err) {
         platform.log.error("An error occurred while getting region [%s].", err);
         callback();
         return;
      }
      if (!body.region) {
         platform.log.error("Server did not response with a region [%s]", response);
         platform.log.warn("\n" + JSON.stringify(body, null, 2));
         callback();
         return;
      }
      let idx = platform.apiHost.indexOf('-');
      if (idx == -1) {
         platform.log.error("Received region [%s]. However we cannot construct the new API host url.", body.region);
         callback();
         return;
      }
      let newApiHost = body.region + platform.apiHost.substring(idx);
      if (platform.apiHost != newApiHost) {
         if (platform.debug) platform.log("Received region [%s], updating API host to [%s].", body.region, newApiHost);
         platform.apiHost = newApiHost;
      }
      callback(body.region);
   }.bind(this));
};

eWeLink.prototype.getWebSocketHost = function (callback) {
   let platform = this;
   if (!platform.log) {
      return;
   }
   var data = {};
   data.accept = 'mqtt,ws';
   data.version = 8;
   data.ts = Math.floor(new Date().getTime() / 1000);
   data.nonce = nonce();
   data.appid = platform.appid;
   
   let webClient = request.createClient('https://' + platform.apiHost.replace('-api', '-disp'));
   webClient.headers['Authorization'] = 'Bearer ' + platform.authenticationToken;
   webClient.headers['Content-Type'] = 'application/json;charset=UTF-8';
   webClient.post('/dispatch/app', data, function (err, res, body) {
      if (err) {
         platform.log.error("An error occurred while getting web socket host [%s].", err);
         callback();
         return;
      }
      
      if (!body.domain) {
         platform.log.error("Server did not response with a web socket host [%s].", response)
         platform.log.warn("\n" + JSON.stringify(body, null, 2));
         callback();
         return;
      }
      
      if (platform.debug) platform.log('Web socket host received [%s].', body.domain);
      platform.wsHost = body.domain;
      if (platform.ws) {
         platform.ws.url = 'wss://' + body.domain + ':8080/api/ws';
      }
      callback(body.domain);
   }.bind(this));
};

eWeLink.prototype.relogin = function (callback) {
   let platform = this;
   if (!platform.log) {
      return;
   }
   platform.login(function () {
      if (platform.webSocketOpen) {
         platform.ws.instance.terminate();
         platform.ws.onclose();
         platform.ws.reconnect();
      }
      callback && callback();
   });
};

eWeLink.prototype.getChannelsByUIID = function (uiid) {
   let platform = this;
   if (!platform.log) {
      return;
   }
   
   const UIID_MAPPING = {
      1: "SOCKET",      // S20, MINI
      2: "SOCKET_2",
      3: "SOCKET_3",
      4: "SOCKET_4",
      5: "SOCKET_POWER",
      6: "SWITCH",     // T1 1C
      7: "SWITCH_2",   // T1 2C, TX2C
      8: "SWITCH_3", // TX3C
      9: "SWITCH_4",
      10: "OSPF",
      11: "CURTAIN",
      12: "EW-RE",
      13: "FIREPLACE",
      14: "SWITCH_CHANGE",
      15: "THERMOSTAT",
      16: "COLD_WARM_LED",
      17: "THREE_GEAR_FAN",
      18: "SENSORS_CENTER",
      19: "HUMIDIFIER",
      22: "RGB_BALL_LIGHT",
      23: "NEST_THERMOSTAT",
      24: "GSM_SOCKET",
      25: "AROMATHERAPY",
      26: "BJ_THERMOSTAT",
      27: "GSM_UNLIMIT_SOCKET",
      28: "RF_BRIDGE", //RFBridge
      29: "GSM_SOCKET_2",
      30: "GSM_SOCKET_3",
      31: "GSM_SOCKET_4",
      32: "POWER_DETECTION_SOCKET",
      33: "LIGHT_BELT",
      34: "FAN_LIGHT",
      35: "EZVIZ_CAMERA",
      36: "SINGLE_CHANNEL_DIMMER_SWITCH",
      38: "HOME_KIT_BRIDGE",
      40: "FUJIN_OPS",
      41: "CUN_YOU_DOOR",
      42: "SMART_BEDSIDE_AND_NEW_RGB_BALL_LIGHT",
      43: "",
      44: "",
      45: "DOWN_CEILING_LIGHT",
      46: "AIR_CLEANER",
      49: "MACHINE_BED",
      51: "COLD_WARM_DESK_LIGHT",
      52: "DOUBLE_COLOR_DEMO_LIGHT",
      53: "ELECTRIC_FAN_WITH_LAMP",
      55: "SWEEPING_ROBOT",
      56: "RGB_BALL_LIGHT_4",
      57: "MONOCHROMATIC_BALL_LIGHT",
      59: "MEARICAMERA",      // L1
      77: "MICRO",
      1001: "BLADELESS_FAN",
      1002: "NEW_HUMIDIFIER",
      1003: "WARM_AIR_BLOWER"
   };
   
   const CHANNEL_MAPPING = {
      SOCKET: 1,
      SWITCH_CHANGE: 1,
      GSM_UNLIMIT_SOCKET: 1,
      SWITCH: 1,
      THERMOSTAT: 1,
      SOCKET_POWER: 1,
      GSM_SOCKET: 1,
      POWER_DETECTION_SOCKET: 1,
      MEARICAMERA: 1,
      SINGLE_CHANNEL_DIMMER_SWITCH: 1,
      RGB_BALL_LIGHT: 1,
      SOCKET_2: 2,
      GSM_SOCKET_2: 2,
      SWITCH_2: 2,
      SOCKET_3: 3,
      GSM_SOCKET_3: 3,
      SWITCH_3: 3,
      SOCKET_4: 4,
      GSM_SOCKET_4: 4,
      SWITCH_4: 4,
      CUN_YOU_DOOR: 4,
      FAN_LIGHT: 4,
      MICRO: 4
   };
   
   let deviceType = UIID_MAPPING[uiid] || "";
   if (deviceType == "") return 0;
   else return CHANNEL_MAPPING[deviceType] || 0;
};

eWeLink.prototype.getArguments = function (apiKey) {
   let platform = this;
   if (!platform.log) {
      return;
   }
   let args = {};
   args.apiKey = apiKey;
   args.version = 8;
   args.ts = Math.floor(new Date().getTime() / 1000);
   args.nonce = nonce();
   args.appid = platform.appid;
   return querystring.stringify(args);
};

eWeLink.prototype.getSignature = function (string) {
   return crypto.createHmac('sha256', '6Nz4n0xA8s8qdxQf2GqurZj2Fs55FUvM').update(string).digest('base64');
};

function WebSocketClient() {
   this.number = 0; // Message number
   this.autoReconnectInterval = 5 * 1000; // ms
   this.pendingReconnect = false;
}

WebSocketClient.prototype.open = function (url) {
   this.url = url;
   this.instance = new WebSocket(this.url);
   this.instance.on('open', () => {
      this.onopen();
   });
   this.instance.on('message', (data, flags) => {
      this.number++;
      this.onmessage(data, flags, this.number);
   });
   this.instance.on('close', (e) => {
      switch (e) {
         case 1005: // CLOSE_NORMAL
         // console.log("WebSocketClient: Web socket closed [1005].");
         break;
         default: // Abnormal closure
         this.reconnect(e);
         break;
      }
      this.onclose(e);
   });
   this.instance.on('error', (e) => {
      switch (e.code) {
         case 'ECONNREFUSED':
         this.reconnect(e);
         break;
         default:
         this.onerror(e);
         break;
      }
   });
};
WebSocketClient.prototype.send = function (data, option) {
   try {
      this.instance.send(data, option);
   } catch (e) {
      this.instance.emit('error', e);
   }
};
WebSocketClient.prototype.reconnect = function (e) {
   if (this.pendingReconnect) return;
   this.pendingReconnect = true;
   this.instance.removeAllListeners();
   setTimeout(function () {
      this.pendingReconnect = false;
      console.log("WebSocketClient: Reconnecting...");
      this.open(this.url);
   }, this.autoReconnectInterval);
};
WebSocketClient.prototype.onopen = function (e) {
   // console.log("WebSocketClient: Web socket opened.", arguments);
};
WebSocketClient.prototype.onmessage = function (data, flags, number) {
   // console.log("WebSocketClient: Message received.", arguments);
};
WebSocketClient.prototype.onerror = function (e) {
   console.log("WebSocketClient: Error", arguments);
};
WebSocketClient.prototype.onclose = function (e) {
   // console.log("WebSocketClient: Web socket closed.", arguments);
};



eWeLink.prototype.getBlindPosition = function (accessory, callback) {
   let platform = this;
   if (!platform.log) {
      return;
   }
   
   let lastPosition = accessory.context.lastPosition;
   if (lastPosition === undefined) {
      lastPosition = 0;
   }
   
   platform.log("[%s] 'getCurrentPosition' is [%s].", accessory.displayName, lastPosition);
   callback(null, lastPosition);
};

eWeLink.prototype.getBlindMovementState = function (accessory, callback) {
   
   let platform = this;
   
   if (!platform.log) {
      return;
   }
   
   if (!platform.webClient) {
      callback("this.webClient not yet ready while obtaining blind position for your device.");
      accessory.reachable = false;
      return;
   }
   
   platform.log("Requesting blind position for [%s]", accessory.displayName);
   
   platform.webClient.get('/api/user/device?' + platform.getArguments(platform.apiKey), function (err, res, body) {
      
      if (err) {
         if (res && [503].indexOf(parseInt(res.statusCode)) !== -1) {
            platform.log('Sonoff API 503 error. Will try again.');
            setTimeout(function () {
               platform.getHumidityState(accessory, callback);
            }, 1000);
         } else {
            platform.log("An error occurred while requesting blind position for [%s]. Error [%s].", accessory.displayName, err);
         }
         return;
      } else if (!body) {
         platform.log("An error occurred while requesting blind position for [%s]. Error [No data in response].", accessory.displayName);
         return;
      } else if (body.hasOwnProperty('error') && body.error != 0) {
         platform.log("An error occurred while requesting blind position for [%s]. Error [%s].", accessory.displayName, JSON.stringify(body));
         if ([401, 402].indexOf(parseInt(body.error)) !== -1) {
            platform.relogin();
         }
         callback('An error occurred while requesting blind position for your device');
         return;
      }
      
      body = body.devicelist;
      
      let size = Object.keys(body)
      .length;
      if (body.length < 1) {
         callback('An error occurred while requesting blind position for your device');
         accessory.reachable = false;
         return;
      }
      let deviceId = accessory.context.hbDeviceId;
      if (accessory.context.switches > 1) {
         deviceId = deviceId.replace("CH" + accessory.context.channel, "");
      }
      let filteredResponse = body.filter(device => (device.deviceid === deviceId));
      
      if (filteredResponse.length === 1) {
         let device = filteredResponse[0];
         if (device.deviceid === deviceId) {
            if (device.online !== true) {
               accessory.reachable = false;
               platform.log("Device [%s] was reported to be offline by the API", accessory.displayName);
               callback('API reported that [%s] is not online', device.name);
               return;
            }
            let switchCount = platform.getChannelsByUIID(device);
            for (let i = 0; i !== switchCount; i++) {
               if (device.params.switches[i].switch === 'on') {
                  accessory.reachable = true;
                  platform.log("API reported that [%s CH-%s] is [on].", device.name, i);
               }
            }
            let currentBlindState = platform.prepareCurrentBlindState(device.params.switches, accessory);
            platform.log("[%s] 'CurrentPositionState' is [%s].", accessory.displayName, currentBlindState);
            // Handling error;
            if (currentBlindState > 2) {
               platform.log("Error with requesting [%s] position. Stopping.", accessory.displayName);
               currentBlindState = 2;
               accessory.context.currentPositionState = 2;
               platform.prepareBlindFinalState(accessory);
            }
            callback(null, currentBlindState);
         }
      } else if (filteredResponse.length > 1) {
         // More than one device matches our Device ID. This should not happen.
         platform.log("Error - the response contained more than one device with ID [%s].", device.deviceid);
         platform.log(filteredResponse);
         callback("The response contained more than one device with ID " + device.deviceid);
      } else if (filteredResponse.length < 1) {
         // The device is no longer registered
         platform.log("Error - [%s] did not exist in the response. Verify the device is connected to your eWeLink account.", accessory.displayName);
         platform.removeAccessory(accessory);
      } else {
         callback('An error occurred while requesting blind position for your device');
      }
   });
};

eWeLink.prototype.getBlindTargetPosition = function (accessory, callback) {
   let platform = this;
   if (!platform.log) {
      return;
   }
   let currentTargetPosition = accessory.context.currentTargetPosition;
   platform.log("[%s] 'getTargetPosition' is [%s].", accessory.displayName, currentTargetPosition);
   callback(null, currentTargetPosition);
};

eWeLink.prototype.setBlindTargetPosition = function (accessory, pos, callback) {
   
   let platform = this;
   
   if (!platform.log) {
      return;
   }
   platform.log("Setting [%s] new target position from [%s] to [%s].", accessory.displayName, accessory.context.currentTargetPosition, pos, );
   
   let timestamp = Date.now();
   
   if (accessory.context.currentPositionState != 2) {
      
      var diffPosition = Math.abs(pos - accessory.context.currentTargetPosition);
      var actualPosition;
      var diffTime;
      var diff;
      
      if (diffPosition == 0) {
         actualPosition = pos;
         diffTime = 0;
         diff = 0;
      } else {
         if (accessory.context.currentPositionState == 1) {
            diffPosition = accessory.context.currentTargetPosition - pos;
            diffTime = Math.round(accessory.context.percentDurationDown * diffPosition);
         } else {
            diffPosition = pos - accessory.context.currentTargetPosition;
            diffTime = Math.round(accessory.context.percentDurationUp * diffPosition);
         }
         diff = (accessory.context.targetTimestamp - timestamp) + diffTime;
         actualPosition = platform.prepareBlindPosition(accessory);
         
         // platform.log("diffPosition:", diffPosition);
         // platform.log("diffTime:", diffTime);
         // platform.log("actualPosition:", actualPosition);
         // platform.log("diff:", diff);
         
         if (diff > 0) {
            accessory.context.targetTimestamp += diffTime;
            // if (pos==0 || pos==100) accessory.context.targetTimestamp += accessory.context.fullOverdrive;
            accessory.context.currentTargetPosition = pos;
            platform.log("[%s] Blinds are moving. Current position: %s, new targuet: %s, adjusting target milliseconds: %s", accessory.displayName, actualPosition, pos, diffTime);
            callback();
            return false;
         }
         if (diff < 0) {
            platform.log("[%s] ==> Revert Blinds moving. Current pos: %s, new targuet: %s, new duration: %s", accessory.displayName, actualPosition, pos, Math.abs(diff));
            accessory.context.startTimestamp = timestamp;
            accessory.context.targetTimestamp = timestamp + Math.abs(diff);
            // if (pos==0 || pos==100) accessory.context.targetTimestamp += accessory.context.fullOverdrive;
            accessory.context.lastPosition = actualPosition;
            accessory.context.currentTargetPosition = pos;
            accessory.context.currentPositionState = accessory.context.currentPositionState == 0 ? 1 : 0;
            
            let payload = platform.prepareBlindPayload(accessory);
            let string = JSON.stringify(payload);
            if (platform.debugReqRes) platform.log.warn(payload);
            
            if (platform.webSocketOpen) {
               platform.sendWebSocketMessage(string, function () {
                  return;
               });
               platform.log("[%s] Request sent for %s", accessory.displayName, accessory.context.currentPositionState == 1 ? "moving up" : "moving down");
               let service = accessory.getService(Service.WindowCovering);
               service.getCharacteristic(Characteristic.CurrentPosition)
               .updateValue(accessory.context.lastPosition);
               service.getCharacteristic(Characteristic.TargetPosition)
               .updateValue(accessory.context.currentTargetPosition);
               service.getCharacteristic(Characteristic.PositionState)
               .updateValue(accessory.context.currentPositionState);
            } else {
               platform.log('Socket was closed. It will reconnect automatically; please retry your command');
               callback('Socket was closed. It will reconnect automatically; please retry your command');
               return false;
            }
         }
         callback();
         return false;
      }
      callback();
      return false;
   }
   
   if (accessory.context.lastPosition == pos) {
      platform.log("[%s] Current position already matches target position. There is nothing to do.", accessory.displayName);
      callback();
      return true;
   }
   
   accessory.context.currentTargetPosition = pos;
   moveUp = (pos > accessory.context.lastPosition);
   
   var withoutmarginetimeUP;
   var withoutmarginetimeDOWN;
   var duration;
   withoutmarginetimeUP = accessory.context.durationUp - accessory.context.durationBMU;
   withoutmarginetimeDOWN = accessory.context.durationDown - accessory.context.durationBMD;
   
   if (moveUp) {
      if (accessory.context.lastPosition == 0) {
         duration = ((pos - accessory.context.lastPosition) / 100 * withoutmarginetimeUP) + accessory.context.durationBMU;
      } else {
         duration = (pos - accessory.context.lastPosition) / 100 * withoutmarginetimeUP;
      }
   } else {
      if (pos == 0) {
         duration = ((accessory.context.lastPosition - pos) / 100 * withoutmarginetimeDOWN) + accessory.context.durationBMD;
      } else {
         duration = (accessory.context.lastPosition - pos) / 100 * withoutmarginetimeDOWN;
      }
   }
   if (pos == 0 || pos == 100) duration += accessory.context.fullOverdrive;
   if (pos == 0 || pos == 100) platform.log("[%s] add overdive: %s", accessory.displayName, accessory.context.fullOverdrive);
   
   duration = Math.round(duration * 100) / 100;
   
   platform.log("[%s] %s, Duration: %s", accessory.displayName, moveUp ? "Moving up" : "Moving down", duration);
   
   accessory.context.startTimestamp = timestamp;
   accessory.context.targetTimestamp = timestamp + (duration * 1000);
   // if (pos==0 || pos==100) accessory.context.targetTimestamp += accessory.context.fullOverdrive;
   accessory.context.currentPositionState = (moveUp ? 0 : 1);
   accessory.getService(Service.WindowCovering)
   .setCharacteristic(Characteristic.PositionState, (moveUp ? 0 : 1));
   
   let payload = platform.prepareBlindPayload(accessory);
   let string = JSON.stringify(payload);
   if (platform.debugReqRes) platform.log.warn(payload);
   
   if (platform.webSocketOpen) {
      
      setTimeout(function () {
         platform.sendWebSocketMessage(string, function () {
            return;
         });
         platform.log("[%s] Request sent for %s", accessory.displayName, moveUp ? "moving up" : "moving down");
         
         var interval = setInterval(function () {
            if (Date.now() >= accessory.context.targetTimestamp) {
               platform.prepareBlindFinalState(accessory);
               clearInterval(interval);
               return true;
            }
         }, 100);
         callback();
      }, 1);
   } else {
      platform.log('Socket was closed. It will reconnect automatically; please retry your command');
      callback('Socket was closed. It will reconnect automatically; please retry your command');
      return false;
   }
};

eWeLink.prototype.prepareCurrentBlindState = function (switches, accessory) {
   
   let platform = this;
   
   if (!platform.log) {
      return;
   }
   
   // platform.log("Switches: %s", switches);
   var switch0 = 0;
   if (switches[accessory.context.switchUp].switch === 'on') {
      switch0 = 1;
   }
   
   var switch1 = 0;
   if (switches[accessory.context.switchDown].switch === 'on') {
      switch1 = 1;
   }
   
   let sum = (switch0 * 2) + switch1;
   
   // this.log("Sum: ", sum);
   // [0,0] = 0 => 2 Stopped
   // [0,1] = 1 => 1 Moving down
   // [1,0] = 2 => 0 Moving up
   // [1,1] = 3 => Error
   
   const MAPPING = {
      0: 2,
      1: 1,
      2: 0,
      3: 3
   };
   // this.log("Sum: %s => Blind State: %s", sum, MAPPING[sum]);
   return MAPPING[sum];
};

eWeLink.prototype.prepareBlindFinalState = function (accessory) {
   
   let platform = this;
   
   if (!platform.log) {
      return;
   }
   accessory.context.currentPositionState = 2;
   let payload = platform.prepareBlindPayload(accessory);
   let string = JSON.stringify(payload);
   if (platform.debugReqRes) platform.log.warn(payload);
   
   if (platform.webSocketOpen) {
      
      setTimeout(function () {
         platform.sendWebSocketMessage(string, function () {
            return;
         });
         platform.log("[%s] Request sent to stop moving", accessory.displayName);
         accessory.context.currentPositionState = 2;
         
         let currentTargetPosition = accessory.context.currentTargetPosition;
         accessory.context.lastPosition = currentTargetPosition;
         let service = accessory.getService(Service.WindowCovering);
         // Using updateValue to avoid loop
         service.getCharacteristic(Characteristic.CurrentPosition)
         .updateValue(currentTargetPosition);
         service.getCharacteristic(Characteristic.TargetPosition)
         .updateValue(currentTargetPosition);
         service.setCharacteristic(Characteristic.PositionState, Characteristic.PositionState.STOPPED);
         
         platform.log("[%s] Successfully moved to target position: %s", accessory.displayName, currentTargetPosition);
         return true;
         // TODO Here we need to wait for the response to the socket
      }, 1);
      
   } else {
      platform.log('Socket was closed. It will reconnect automatically; please retry your command');
      return false;
   }
};

eWeLink.prototype.prepareBlindPayload = function (accessory) {
   
   let platform = this;
   if (!platform.log) {
      return;
   }
   let payload = {};
   payload.action = 'update';
   payload.userAgent = 'app';
   payload.params = {};
   let deviceFromApi = platform.devicesInEwe.get(accessory.context.hbDeviceId);
   
   payload.params.switches = deviceFromApi.params.switches;
   
   // [0,0] = 0 => 2 Stopped
   // [0,1] = 1 => 1 Moving down
   // [1,0] = 2 => 0 Moving up
   // [1,1] = 3 => should not happen...
   
   var switch0 = 'off';
   var switch1 = 'off';
   
   let state = accessory.context.currentPositionState;
   
   switch (state) {
      case 2:
      switch0 = 'off';
      switch1 = 'off';
      break;
      case 1:
      switch0 = 'off';
      switch1 = 'on';
      break;
      case 0:
      switch0 = 'on';
      switch1 = 'off';
      break;
      default:
      platform.log('[%s] PositionState type error !', accessory.displayName);
      break;
   }
   
   payload.params.switches[accessory.context.switchUp].switch = switch0;
   payload.params.switches[accessory.context.switchDown].switch = switch1;
   payload.apikey = accessory.context.eweApiKey;
   payload.deviceid = accessory.context.hbDeviceId;
   payload.sequence = platform.getSequence();
   // platform.log("Payload genretad:", JSON.stringify(payload))
   return payload;
};

eWeLink.prototype.prepareBlindPosition = function (accessory) {
   let timestamp = Date.now();
   if (accessory.context.currentPositionState == 1) {
      return Math.round(accessory.context.lastPosition - ((timestamp - accessory.context.startTimestamp) / accessory.context.percentDurationDown));
   } else if (accessory.context.currentPositionState == 0) {
      return Math.round(accessory.context.lastPosition + ((timestamp - accessory.context.startTimestamp) / accessory.context.percentDurationUp));
   } else {
      return accessory.context.lastPosition;
   }
};


