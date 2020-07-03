const ws = require("ws");
const nonce = require("nonce")();
const crypto = require("crypto");
const convert = require("color-convert");
const axios = require("axios");
let platform;
let Accessory;
let Service;
let Characteristic;
let UUIDGen;
module.exports = function (homebridge) {
   Accessory = homebridge.platformAccessory;
   Service = homebridge.hap.Service;
   Characteristic = homebridge.hap.Characteristic;
   UUIDGen = homebridge.hap.uuid;
   homebridge.registerPlatform("homebridge-ewelink-sonoff", "eWeLink", eWeLink, true);
};
class eWeLink {
   constructor(log, config, api) {
      if (!log || !api) {
         return;
      }
      if (!config || (!config.username || !config.password || !config.countryCode)) {
         log.error("******************************************************************************************");
         log.warn("Cannot load plugin - check your eWeLink username, password and country code in the config.");
         log.error("******************************************************************************************");
         return;
      }
      platform = this;
      platform.log = log;
      platform.config = config;
      platform.api = api;
      platform.apiKey = "UNCONFIGURED";
      platform.authenticationToken = "UNCONFIGURED";
      platform.appid = "oeVkj2lYFGnJu5XUtWisfW4utiN4u9Mq";
      platform.emailLogin = platform.config.username.includes("@");
      platform.apiHost = (platform.config.apiHost || "eu-api.coolkit.cc") + ":8080";
      platform.wsHost = platform.config.wsHost || "eu-pconnect3.coolkit.cc";
      platform.wsIsOpen = false;
      platform.wsToReconnect = false;
      platform.debug = platform.config.debug || false;
      platform.debugReqRes = platform.config.debugReqRes || false;
      platform.sensorTimeLength = platform.config.sensorTimeLength || 2;
      platform.sensorTimeDifference = platform.config.sensorTimeDifference || 120;
      platform.devicesInHB = new Map();
      platform.devicesInEwe = new Map();
      platform.devicesUnsupported = [];
      platform.devicesSingleSwitch = [1, 5, 6, 14, 15, 22, 24, 27, 32, 36, 44, 59];
      platform.devicesSingleSwitchLight = ["T1 1C", "L1", "B1", "B1_R2", "TX1C", "D1", "D1R1", "KING-M4", "Slampher"];
      platform.devicesMultiSwitch = [2, 3, 4, 7, 8, 9, 29, 30, 31, 34, 41, 77];
      platform.devicesMultiSwitchLight = ["T1 2C", "T1 3C", "TX2C", "TX3C"];
      platform.devicesBrightable = [36, 44];
      platform.devicesColourable = [22, 59];
      platform.devicesThermostat = [15];
      platform.devicesFan = [34];
      platform.devicesOutlet = [32];
      platform.devicesBridge = [28];
      platform.customGroup = new Map();
      platform.customGroupDefs = {
         switchUp: 1,
         switchDown: 2,
         timeUp: 40,
         timeDown: 20,
         timeBottomMarginUp: 0,
         timeBottomMarginDown: 0,
         fullOverdrive: 0
      };
      platform.api.on("didFinishLaunching", function () {
         let afterLogin = function () {
            if (platform.apiKey === "UNCONFIGURED") return;
            let eWeLinkDevices;
            axios.get("https://" + platform.apiHost + "/api/user/device", {
               params: {
                  apiKey: platform.apiKey,
                  version: 8,
                  ts: Math.floor(new Date().getTime() / 1000),
                  nonce: nonce(),
                  appid: platform.appid
               },
               headers: {
                  "Authorization": "Bearer " + platform.authenticationToken
               }
            }).then((res) => {
               let body = res.data;
               if (platform.debug) platform.log("Authorisation token received [%s].", platform.authenticationToken);
               if (platform.debug) platform.log("User API key received [%s].", platform.apiKey);
               if (platform.debug) platform.log("Requesting a list of devices through the eWeLink HTTPS API.");
               if (body.hasOwnProperty("error") && body.error !== 0) {
                  if (body.error === 401) throw "Authorisation token error";
                  else if (body.error === 406) throw "Incorrect eWeLink username, password and country code in the config.";
                  else throw JSON.stringify(body, null, 2);
                  return;
               }
               eWeLinkDevices = body.devicelist;
            }).catch(function (error) {
               platform.log.error("****** An error occurred connecting to the HTTPS API ******");
               platform.log.warn("%s.", error);
               platform.log.error("****** This plugin will stop loading due to this error. ******");
               return;
            }).then(function () {
               if (eWeLinkDevices === undefined) return;
               let primaryDeviceCount = Object.keys(eWeLinkDevices).length;
               if (primaryDeviceCount === 0) {
                  platform.log("[0] primary devices were loaded from your eWeLink account.");
                  platform.log("Any existing eWeLink devices in the Homebridge cache will be removed.");
                  platform.log("This plugin will not be loaded as there is no reason to.");
                  try {
                     platform.api.unregisterPlatformAccessories("homebridge-ewelink-sonoff", "eWeLink", Array.from(platform.devicesInHB.values()));
                     platform.devicesInHB.clear();
                  } catch (e) {
                     platform.log.warn("Devices could not be removed from the cache - [%s].");
                  }
                  return;
               }
               // The eWeLink devices are stored in the "platform.devicesInEwe" map with the device ID as the key (without the SW*) part.
               // platform.log.warn(JSON.stringify(eWeLinkDevices, null, 2));
               eWeLinkDevices.forEach((device) => {
                  if (!platform.devicesUnsupported.includes(device.uiid)) {
                     platform.devicesInEwe.set(device.deviceid, device);
                  }
               });
               // Blind groupings found in the configuration are set in the "platform.customGroup" map.
               if (platform.config.groups && Object.keys(platform.config.groups).length > 0) {
                  platform.config.groups.forEach((group) => {
                     if (typeof group.deviceId !== "undefined" && platform.devicesInEwe.has(group.deviceId + "SWX")) {
                        platform.customGroup.set(group.deviceId + "SWX", group);
                     }
                  });
               }
               platform.log("[%s] eWeLink devices were loaded from the Homebridge cache..", platform.devicesInHB.size);
               platform.log("[%s] primary devices were loaded from your eWeLink account.", primaryDeviceCount);
               platform.log("[%s] groups were loaded from the Homebridge configuration.", platform.customGroup.size);
               platform.log("The Homebridge configuration for these devices will be refreshed.");
               if (platform.debug) platform.log("Checking if devices need to be removed from the Homebridge cache.");
               if (platform.devicesInHB.size > 0) {
                  platform.devicesInHB.forEach((accessory) => {
                     if (!platform.devicesInEwe.has(accessory.context.eweDeviceId)) {
                        if (platform.debug) platform.log("[%s] was not present in the HTTP API response so removing from Homebridge.", accessory.displayName);
                        platform.removeAccessory(accessory);
                     }
                  });
               }
               if (platform.debug) platform.log("Checking if devices need to be added/refreshed in the Homebridge cache.");
               if (platform.devicesInEwe.size > 0) {
                  platform.devicesInEwe.forEach((device) => {
                     let i;
                     // Add non-existing devices
                     if (!platform.devicesInHB.has(device.deviceid + "SWX") && !platform.devicesInHB.has(device.deviceid + "SW0")) {
                        //*** CUSTOM GROUPS ***//
                        if (platform.customGroup.has(device.deviceid)) {
                           if (platform.customGroup.get(device.deviceid).type === "blind" && Array.isArray(device.params.switches)) {
                              platform.addAccessory(device, device.deviceid + "SWX", "blind");
                           }
                        }
                        //*** FANS ***//                              
                        else if (platform.devicesFan.includes(device.uiid)) {
                           if (Array.isArray(device.params.switches)) {
                              platform.addAccessory(device, device.deviceid + "SWX", "fan");
                           }
                        }
                        //*** THERMOSTATS ***//                                                                            
                        else if (platform.devicesThermostat.includes(device.uiid)) {
                           if (device.params.hasOwnProperty("switch") || device.params.hasOwnProperty("mainSwitch")) {
                              platform.addAccessory(device, device.deviceid + "SWX", "thermostat");
                           }
                        }
                        //*** OUTLETS ***//         
                        else if (platform.devicesOutlet.includes(device.uiid)) {
                           if (device.params.hasOwnProperty("switch")) {
                              platform.addAccessory(device, device.deviceid + "SWX", "outlet");
                           }
                        }
                        //*** LIGHTS [SINGLE SWITCH] ***//
                        else if (platform.devicesSingleSwitch.includes(device.uiid) && platform.devicesSingleSwitchLight.includes(device.productModel)) {
                           if (device.params.hasOwnProperty("switch") || device.params.hasOwnProperty("state")) {
                              let service;
                              if (platform.devicesColourable.includes(device.uiid)) service = "lightc";
                              else if (platform.devicesBrightable.includes(device.uiid)) service = "lightb";
                              else service = "light";
                              platform.addAccessory(device, device.deviceid + "SWX", service);
                           }
                        }
                        //*** LIGHTS [MULTI SWITCH] ***//
                        else if (platform.devicesMultiSwitch.includes(device.uiid) && platform.devicesMultiSwitchLight.includes(device.productModel)) {
                           if (Array.isArray(device.params.switches)) {
                              for (i = 0; i <= platform.helperChannelsByUIID(device.uiid); i++) {
                                 platform.addAccessory(device, device.deviceid + "SW" + i, "light");
                              }
                           }
                        }
                        //*** SINGLE SWITCHES ***//
                        else if (platform.devicesSingleSwitch.includes(device.uiid)) {
                           if (device.params.hasOwnProperty("switch")) {
                              platform.addAccessory(device, device.deviceid + "SWX", "switch");
                           }
                        }
                        //*** MULTI SWITCHES ***//
                        else if (platform.devicesMultiSwitch.includes(device.uiid)) {
                           if (Array.isArray(device.params.switches)) {
                              for (i = 0; i <= platform.helperChannelsByUIID(device.uiid); i++) {
                                 platform.addAccessory(device, device.deviceid + "SW" + i, "switch");
                              }
                           }
                        }
                        //*** BRIDGES ***//        
                        else if (platform.devicesBridge.includes(device.uiid)) {
                           if (device.params.hasOwnProperty("rfList")) {
                              for (i = 0; i <= Object.keys(device.params.rfList).length; i++) {
                                 platform.addAccessory(device, device.deviceid + "SW" + i, "bridge");
                              }
                           }
                        }
                        //*** NOT SUPPORTED ***//
                        else {
                           platform.log.warn("[%s] cannot be added as it is not supported by this plugin.", device.name);
                        }
                     }
                     // Refresh existing devices and also those that have just been added.
                     if (platform.devicesInHB.has(device.deviceid + "SWX") || platform.devicesInHB.has(device.deviceid + "SW0")) {
                        let accessory;
                        if (platform.devicesInHB.has(device.deviceid + "SWX")) {
                           accessory = platform.devicesInHB.get(device.deviceid + "SWX");
                        } else {
                           accessory = platform.devicesInHB.get(device.deviceid + "SW0");
                        }
                        if (!device.online) {
                           platform.log.warn("[%s] has been reported offline so cannot refresh.", accessory.displayName);
                           return;
                        }
                        if (platform.debug) platform.log("[%s] has been found in Homebridge so refresh status.", accessory.displayName);
                        accessory.getService(Service.AccessoryInformation).updateCharacteristic(Characteristic.FirmwareRevision, device.params.fwVersion);
                        accessory.reachable = device.online;
                        //*** CUSTOM GROUPS ***//  
                        if (platform.customGroup.has(device.deviceid + "SWX")) {
                           if (platform.customGroup.get(device.deviceid + "SWX").type === "blind" && Array.isArray(device.params.switches)) {
                              platform.externalBlindUpdate(device.deviceid + "SWX", device.params);
                              return;
                           }
                        }
                        //*** FANS ***//                                        
                        else if (platform.devicesFan.includes(accessory.context.eweUIID)) {
                           if (Array.isArray(device.params.switches)) {
                              platform.externalFanUpdate(device.deviceid + "SWX", device.params);
                              return;
                           }
                        }
                        //*** THERMOSTATS ***//                                    
                        else if (platform.devicesThermostat.includes(accessory.context.eweUIID)) {
                           if (device.params.hasOwnProperty("currentTemperature") || device.params.hasOwnProperty("currentHumidity") || device.params.hasOwnProperty("switch") || device.params.hasOwnProperty("masterSwitch")) {
                              platform.externalThermostatUpdate(device.deviceid + "SWX", device.params);
                              return;
                           }
                        }
                        //*** OUTLETS ***//       
                        else if (platform.devicesOutlet.includes(accessory.context.eweUIID)) {
                           if (device.params.hasOwnProperty("switch")) {
                              platform.externalOutletUpdate(device.deviceid + "SWX", device.params);
                              return;
                           }
                        }
                        //*** LIGHTS [SINGLE SWITCH] ***//
                        else if (platform.devicesSingleSwitch.includes(accessory.context.eweUIID) && platform.devicesSingleSwitchLight.includes(accessory.context.eweModel)) {
                           if (device.params.hasOwnProperty("switch") || device.params.hasOwnProperty("state") || device.params.hasOwnProperty("bright") || device.params.hasOwnProperty("colorR") || device.params.hasOwnProperty("brightness") || device.params.hasOwnProperty("channel0") || device.params.hasOwnProperty("channel2") || device.params.hasOwnProperty("zyx_mode")) {
                              platform.externalSingleLightUpdate(device.deviceid + "SWX", device.params);
                              return;
                           }
                        }
                        //*** LIGHTS [MULTI SWITCH] ***//
                        else if (platform.devicesMultiSwitch.includes(accessory.context.eweUIID) && platform.devicesMultiSwitchLight.includes(accessory.context.eweModel)) {
                           if (Array.isArray(device.params.switches)) {
                              platform.externalMultiLightUpdate(device.deviceid + "SW0", device.params);
                              return;
                           }
                        }
                        //*** SINGLE SWITCHES ***//      
                        else if (platform.devicesSingleSwitch.includes(accessory.context.eweUIID)) {
                           if (device.params.hasOwnProperty("switch")) {
                              platform.externalSingleSwitchUpdate(device.deviceid + "SWX", device.params);
                              return;
                           }
                        }
                        //*** MULTI SWITCHES ***//
                        else if (platform.devicesMultiSwitch.includes(accessory.context.eweUIID)) {
                           if (Array.isArray(device.params.switches)) {
                              platform.externalMultiSwitchUpdate(device.deviceid + "SW0", device.params);
                              return;
                           }
                        }
                        //*** BRIDGES ***//
                        else if (platform.devicesBridge.includes(accessory.context.eweUIID)) {
                           if (Array.isArray(device.params)) {
                              platform.externalBridgeUpdate(device.deviceid + "SW0", device.params);
                              return;
                           }
                        }
                        //*** NOT SUPPORTED ***//
                        else {
                           platform.log.warn("[%s] could not be refreshed as it wasn't found in Homebridge.", device.name);
                        }
                     }
                  });
               }
               // Let's open a web socket to the eWeLink server to receive real-time updates about external changes to devices.
               if (platform.debug) platform.log("Opening web socket for real time updates.");
               platform.ws = new WSC();
               platform.ws.open("wss://" + platform.wsHost + ":8080/api/ws");
               platform.ws.onopen = function (e) {
                  platform.wsIsOpen = true;
                  let payload = {
                     action: "userOnline",
                     at: platform.authenticationToken,
                     apikey: platform.apiKey,
                     appid: platform.appid,
                     nonce: nonce(),
                     ts: Math.floor(new Date() / 1000),
                     userAgent: "app",
                     sequence: Math.floor(new Date()),
                     version: 8
                  };
                  platform.ws.send(JSON.stringify(payload));
                  if (platform.debugReqRes) platform.log.warn("Sending web socket login request.\n" + JSON.stringify(payload, null, 2));
               };
               platform.ws.onerror = function (e) {
                  platform.log.error("Web socket error - [%s].", e);
                  platform.log.error("Please try restarting Homebridge so that this plugin can work again.");
               };
               platform.ws.onclose = function (e) {
                  platform.log.warn("Web socket was closed - [%s].", e);
                  platform.log.warn("Web socket will try to reconnect in a few seconds.");
                  platform.log.warn("Then please try the command again.");
                  platform.isSocketOpen = false;
                  if (platform.hbInterval) {
                     clearInterval(platform.hbInterval);
                     platform.hbInterval = null;
                  }
               };
               platform.ws.onmessage = function (m) {
                  if (m === "pong") return;
                  if (platform.debugReqRes) platform.log.warn("Web socket message received.\n" + JSON.stringify(JSON.parse(m), null, 2));
                  else if (platform.debug) platform.log("Web socket message received.");
                  let device;
                  try {
                     device = JSON.parse(m);
                  } catch (e) {
                     platform.log.warn("An error occured reading the web socket message [%s]", e);
                     return;
                  }
                  if (device.hasOwnProperty("action")) {
                     let idToCheck = device.deviceid;
                     let accessory;
                     if (device.action === "update" && device.hasOwnProperty("params")) {
                        if (platform.debug) platform.log("External update received via web socket.");
                        if (platform.devicesInHB.has(idToCheck + "SWX") || platform.devicesInHB.has(idToCheck + "SW0")) {
                           if (platform.devicesInHB.has(idToCheck + "SWX")) {
                              accessory = platform.devicesInHB.get(idToCheck + "SWX");
                           } else {
                              accessory = platform.devicesInHB.get(idToCheck + "SW0");
                           }
                           if (!accessory.reachable) {
                              platform.log.warn("[%s] has been reported offline so cannot refresh.", accessory.displayName);
                              return;
                           }
                           if (platform.debug) platform.log("[%s] has been found in Homebridge so refresh status.", accessory.displayName);
                           accessory.getService(Service.AccessoryInformation).updateCharacteristic(Characteristic.FirmwareRevision, device.params.fwVersion);
                           //*** CUSTOM GROUPS ***//       
                           if (platform.customGroup.has(idToCheck + "SWX")) {
                              if (platform.customGroup.get(idToCheck + "SWX").type === "blind" && Array.isArray(device.params.switches)) {
                                 platform.externalBlindUpdate(idToCheck + "SWX", device.params);
                                 return;
                              }
                           }
                           //*** FANS ***//                                         
                           else if (platform.devicesFan.includes(accessory.context.eweUIID)) {
                              if (Array.isArray(device.params.switches)) {
                                 platform.externalFanUpdate(idToCheck + "SWX", device.params);
                                 return;
                              }
                           }
                           //*** THERMOSTATS ***//                                   
                           else if (platform.devicesThermostat.includes(accessory.context.eweUIID)) {
                              if (device.params.hasOwnProperty("currentTemperature") || device.params.hasOwnProperty("currentHumidity") || device.params.hasOwnProperty("switch") || device.params.hasOwnProperty("masterSwitch")) {
                                 platform.externalThermostatUpdate(idToCheck + "SWX", device.params);
                                 return;
                              }
                           }
                           
                           //*** OUTLETS ***//  
                           else if (platform.devicesOutlet.includes(accessory.context.eweUIID)) {
                              if (device.params.hasOwnProperty("switch")) {
                                 platform.externalOutletUpdate(idToCheck + "SWX", device.params);
                                 return;
                              }
                           }
                           //*** LIGHTS [SINGLE SWITCH] ***//      
                           else if (platform.devicesSingleSwitch.includes(accessory.context.eweUIID) && platform.devicesSingleSwitchLight.includes(accessory.context.eweModel)) {
                              if (device.params.hasOwnProperty("switch") || device.params.hasOwnProperty("state") || device.params.hasOwnProperty("bright") || device.params.hasOwnProperty("colorR") || device.params.hasOwnProperty("brightness") || device.params.hasOwnProperty("channel0") || device.params.hasOwnProperty("channel2") || device.params.hasOwnProperty("zyx_mode")) {
                                 platform.externalSingleLightUpdate(idToCheck + "SWX", device.params);
                                 return;
                              }
                           }
                           //*** LIGHTS [MULTI SWITCH] ***//
                           else if (platform.devicesMultiSwitch.includes(accessory.context.eweUIID) && platform.devicesMultiSwitchLight.includes(accessory.context.eweModel)) {
                              if (Array.isArray(device.params.switches)) {
                                 platform.externalMultiLightUpdate(idToCheck + "SW0", device.params);
                                 return;
                              }
                           }
                           //*** SINGLE SWITCHES ***//
                           else if (platform.devicesSingleSwitch.includes(accessory.context.eweUIID)) {
                              if (device.params.hasOwnProperty("switch")) {
                                 platform.externalSingleSwitchUpdate(idToCheck + "SWX", device.params);
                                 return;
                              }
                           }
                           //*** MULTI SWITCHES ***//
                           else if (platform.devicesMultiSwitch.includes(accessory.context.eweUIID)) {
                              if (Array.isArray(device.params.switches)) {
                                 platform.externalMultiSwitchUpdate(idToCheck + "SW0", device.params);
                                 return;
                              }
                           }
                           //*** BRIDGES ***//
                           else if (platform.devicesBridge.includes(accessory.context.eweUIID)) {
                              if (device.params.hasOwnProperty("cmd") && device.params.cmd === "trigger") {
                                 platform.externalBridgeUpdate(idToCheck + "SW0", device.params);
                                 return;
                              }
                           }
                           if (device.params.hasOwnProperty("power") || device.params.hasOwnProperty("rssi") || device.params.hasOwnProperty("uiActive")) {
                              // Catch other updates that don't relate to Homebridge, for example wifi signal strength.
                              return;
                           }
                           if (platform.debug) platform.log("[%s] wasn't refreshed as there was nothing to do.", device.deviceid);
                        } else {
                           platform.log.warn("[%s] Accessory received via web socket does not exist in Homebridge.", device.deviceid);
                           platform.log.warn("If it's a new accessory please try restarting Homebridge so it is added.");
                        }
                     } else if (device.action === "sysmsg") {
                        if (platform.devicesInHB.has(device.deviceid + "SWX")) {
                           accessory = platform.devicesInHB.get(device.deviceid + "SWX");
                        } else if (platform.devicesInHB.has(device.deviceid + "SW0")) {
                           accessory = platform.devicesInHB.get(device.deviceid + "SW0");
                        } else {
                           accessory = false;
                        }
                        if (accessory) {
                           accessory.reachable = device.params.online;
                           if (accessory.reachable) platform.log("[%s] has been reported online.", accessory.displayName);
                           else platform.log.warn("[%s] has been reported offline.", accessory.displayName);
                        } else {
                           platform.log.warn("A device that you don't have in Homebridge has been reported [%s].", device.online ? "online" : "offline");
                        }
                     } else {
                        if (platform.debug) platform.log.warn("Unknown action property or no parameters received via web socket.");
                     }
                  } else if (device.hasOwnProperty("config") && device.config.hb && device.config.hbInterval) {
                     if (!platform.hbInterval) {
                        platform.hbInterval = setInterval(function () {
                           platform.ws.send("ping");
                        }, device.config.hbInterval * 1000);
                     }
                  } else {
                     if (platform.debug) platform.log.warn("Unknown command received via web socket.");
                  }
               };
               platform.log("Plugin initialisation has been successful.");
            });
         };
         platform.httpGetRegion(function () {
            platform.httpLogin(afterLogin.bind(platform));
         }.bind(platform));
      }.bind(platform));
   }
   
   addAccessory(device, hbDeviceId, service) {
      if (platform.devicesInHB.get(hbDeviceId)) {
         return; // device is already in Homebridge.
      }
      if (device.type !== "10") {
         platform.log.warn("[%s] cannot be added as it is not supported by this plugin.", device.name);
         return;
      }
      let channelCount = service === "bridge" ? Object.keys(device.params.rfList).length : platform.helperChannelsByUIID(device.uiid);
      let switchNumber = hbDeviceId.substr(-1);
      if (switchNumber > channelCount) {
         platform.log.warn("[%s] cannot be added as the [%s] only has [%s] switches.", device.name, device.productModel, channelCount);
         return;
      }
      let newDeviceName;
      if (switchNumber === "X" || switchNumber === "0") {
         newDeviceName = device.name;
      } else {
         newDeviceName = device.name + " SW" + switchNumber;
      }
      const accessory = new Accessory(newDeviceName, UUIDGen.generate(hbDeviceId).toString());
      accessory.context.hbDeviceId = hbDeviceId;
      accessory.context.eweDeviceId = hbDeviceId.slice(0, -3);
      accessory.context.eweUIID = device.uiid;
      accessory.context.eweModel = device.productModel;
      accessory.context.eweApiKey = device.apikey;
      accessory.context.switchNumber = switchNumber;
      accessory.context.channelCount = channelCount;
      accessory.reachable = device.online;
      accessory.on("identify", function (paired, callback) {
         platform.log("[%s] identified. Identification on device not supported.", accessory.displayName);
         try {
            callback();
         } catch (e) {}
      });
      switch (service) {
      case "blind":
         let group = platform.customGroup.get(accessory.context.hbDeviceId);
         accessory.addService(Service.WindowCovering).getCharacteristic(Characteristic.TargetPosition)
            .on("set", function (value, callback) {
               platform.internalBlindUpdate(accessory, value, callback);
            });
         accessory.getService(Service.WindowCovering).updateCharacteristic(Characteristic.CurrentPosition, 0);
         accessory.getService(Service.WindowCovering).updateCharacteristic(Characteristic.TargetPosition, 0);
         accessory.getService(Service.WindowCovering).updateCharacteristic(Characteristic.PositionState, 2);
         accessory.context.switchUp = (group.switchUp || platform.customGroupDefs.switchUp) - 1;
         accessory.context.switchDown = (group.switchDown || platform.customGroupDefs.switchDown) - 1;
         accessory.context.durationUp = group.timeUp || platform.customGroupDefs.timeUp;
         accessory.context.durationDown = group.timeDown || platform.customGroupDefs.timeDown;
         accessory.context.durationBMU = group.timeBottomMarginUp || platform.customGroupDefs.timeBottomMarginUp;
         accessory.context.durationBMD = group.timeBottomMarginDown || platform.customGroupDefs.timeBottomMarginDown;
         accessory.context.fullOverdrive = platform.customGroupDefs.fullOverdrive;
         accessory.context.percentDurationDown = accessory.context.durationDown * 10;
         accessory.context.percentDurationUp = accessory.context.durationUp * 10;
         break;
      case "fan":
         accessory.addService(Service.Fanv2).getCharacteristic(Characteristic.On)
            .on("set", function (value, callback) {
               platform.internalFanUpdate(accessory, "power", value, callback);
            });
         accessory.getService(Service.Fanv2).getCharacteristic(Characteristic.RotationSpeed)
            .setProps({
               minStep: 3
            })
            .on("set", function (value, callback) {
               platform.internalFanUpdate(accessory, "speed", value, callback);
            });
         accessory.addService(Service.Lightbulb).getCharacteristic(Characteristic.On)
            .on("set", function (value, callback) {
               platform.internalFanUpdate(accessory, "light", value, callback);
            });
         accessory.getService(Service.Fanv2).setCharacteristic(Characteristic.Active, 1);
         break;
      case "thermostat":
         accessory.addService(Service.Switch).getCharacteristic(Characteristic.On)
            .on("set", function (value, callback) {
               platform.internalThermostatUpdate(accessory, value, callback);
            });
         accessory.addService(Service.TemperatureSensor);
         if (device.params.sensorType !== "DS18B20") {
            accessory.addService(Service.HumiditySensor);
         }
         break;
      case "outlet":
         accessory.addService(Service.Outlet).getCharacteristic(Characteristic.On)
            .on("set", function (value, callback) {
               platform.internalOutletUpdate(accessory, value, callback);
            });
         accessory.getService(Service.Outlet).setCharacteristic(Characteristic.OutletInUse, true);
         break;
      case "light":
      case "lightb":
      case "lightc":
         accessory.addService(Service.Lightbulb).getCharacteristic(Characteristic.On)
            .on("set", function (value, callback) {
               if (accessory.getService(Service.Lightbulb).getCharacteristic(Characteristic.On).value !== value) {
                  platform.internalLightbulbUpdate(accessory, value, callback);
               } else {
                  callback();
               }
            });
         if (service === "lightb") {
            accessory.getService(Service.Lightbulb).getCharacteristic(Characteristic.Brightness)
               .on("set", function (value, callback) {
                  if (value > 0) {
                     if (!accessory.getService(Service.Lightbulb).getCharacteristic(Characteristic.On).value) {
                        platform.internalLightbulbUpdate(accessory, true, callback);
                     }
                     if (accessory.getService(Service.Lightbulb).getCharacteristic(Characteristic.Brightness).value !== value) {
                        platform.internalBrightnessUpdate(accessory, value, callback);
                     } else {
                        callback();
                     }
                  } else {
                     if (accessory.getService(Service.Lightbulb).getCharacteristic(Characteristic.On).value) {
                        platform.internalLightbulbUpdate(accessory, false, callback);
                     } else {
                        callback();
                     }
                  }
               });
         }
         if (service === "lightc") {
            accessory.getService(Service.Lightbulb).getCharacteristic(Characteristic.Brightness)
               .on("set", function (value, callback) {
                  if (value > 0) {
                     if (!accessory.getService(Service.Lightbulb).getCharacteristic(Characteristic.On).value) {
                        platform.internalLightbulbUpdate(accessory, true, callback);
                     }
                     if (accessory.getService(Service.Lightbulb).getCharacteristic(Characteristic.Brightness).value !== value) {
                        platform.internalHSBUpdate(accessory, "bri", value, callback);
                     } else {
                        callback();
                     }
                  } else {
                     if (accessory.getService(Service.Lightbulb).getCharacteristic(Characteristic.On).value) {
                        platform.internalLightbulbUpdate(accessory, false, callback);
                     } else {
                        callback();
                     }
                  }
               });
            accessory.getService(Service.Lightbulb).getCharacteristic(Characteristic.Hue)
               .on("set", function (value, callback) {
                  if (accessory.getService(Service.Lightbulb).getCharacteristic(Characteristic.Hue).value !== value) {
                     platform.internalHSBUpdate(accessory, "hue", value, callback);
                  } else {
                     callback();
                  }
               });
            accessory.getService(Service.Lightbulb).getCharacteristic(Characteristic.Saturation)
               .on("set", function (value, callback) {
                  accessory.getService(Service.Lightbulb).updateCharacteristic(Characteristic.Saturation, value);
                  callback();
               });
         }
         break;
      case "switch":
         accessory.addService(Service.Switch).getCharacteristic(Characteristic.On)
            .on("set", function (value, callback) {
               platform.internalSwitchUpdate(accessory, value, callback);
            });
         break;
      case "bridge":
         accessory.addService(Service.MotionSensor).setCharacteristic(Characteristic.MotionDetected, false);
         break;
      default:
         platform.log.warn("[%s] cannot be added as it is not supported by this plugin.", accessory.deviceName);
         return;
      }
      try {
         accessory.getService(Service.AccessoryInformation).setCharacteristic(Characteristic.SerialNumber, hbDeviceId);
         accessory.getService(Service.AccessoryInformation).setCharacteristic(Characteristic.Manufacturer, device.brandName);
         accessory.getService(Service.AccessoryInformation).setCharacteristic(Characteristic.Model, device.productModel + " (" + device.extra.extra.model + ")");
         accessory.getService(Service.AccessoryInformation).setCharacteristic(Characteristic.Identify, false);
         accessory.getService(Service.AccessoryInformation).setCharacteristic(Characteristic.FirmwareRevision, device.params.fwVersion);
         platform.devicesInHB.set(hbDeviceId, accessory);
         platform.api.registerPlatformAccessories("homebridge-ewelink-sonoff", "eWeLink", [accessory]);
         if (platform.debug) platform.log("[%s] has been added to Homebridge.", newDeviceName);
      } catch (e) {
         platform.log.warn("[%s] cannot be added - [%s].", accessory.displayName, e);
      }
   }
   
   configureAccessory(accessory) {
      if (accessory.getService(Service.WindowCovering)) {
         accessory.getService(Service.WindowCovering).getCharacteristic(Characteristic.TargetPosition)
            .on("set", function (value, callback) {
               platform.internalBlindUpdate(accessory, value, callback);
            });
         accessory.getService(Service.WindowCovering).updateCharacteristic(Characteristic.CurrentPosition, 0);
         accessory.getService(Service.WindowCovering).updateCharacteristic(Characteristic.TargetPosition, 0);
         accessory.getService(Service.WindowCovering).updateCharacteristic(Characteristic.PositionState, 2);
      } else if (accessory.getService(Service.Fanv2)) {
         accessory.getService(Service.Fanv2).setCharacteristic(Characteristic.Active, 1);
         accessory.getService(Service.Fanv2).getCharacteristic(Characteristic.On)
            .on("set", function (value, callback) {
               platform.internalFanUpdate(accessory, "power", value, callback);
            });
         accessory.getService(Service.Fanv2).getCharacteristic(Characteristic.RotationSpeed)
            .setProps({
               minStep: 3
            })
            .on("set", function (value, callback) {
               platform.internalFanUpdate(accessory, "speed", value, callback);
            });
         accessory.getService(Service.Lightbulb).getCharacteristic(Characteristic.On)
            .on("set", function (value, callback) {
               platform.internalFanUpdate(accessory, "light", value, callback);
            });
      } else if (platform.devicesThermostat.includes(accessory.context.eweUIID)) {
         accessory.getService(Service.Switch).getCharacteristic(Characteristic.On)
            .on("set", function (value, callback) {
               platform.internalThermostatUpdate(accessory, value, callback);
            });
      } else if (accessory.getService(Service.Outlet)) {
         accessory.getService(Service.Outlet).getCharacteristic(Characteristic.On)
            .on("set", function (value, callback) {
               platform.internalOutletUpdate(accessory, value, callback);
            });
         accessory.getService(Service.Outlet).setCharacteristic(Characteristic.OutletInUse, true);
      } else if (accessory.getService(Service.Lightbulb)) {
         accessory.getService(Service.Lightbulb).getCharacteristic(Characteristic.On)
            .on("set", function (value, callback) {
               if (accessory.getService(Service.Lightbulb).getCharacteristic(Characteristic.On).value !== value) {
                  platform.internalLightbulbUpdate(accessory, value, callback);
               } else {
                  callback();
               }
            });
         if (platform.devicesBrightable.includes(accessory.context.eweUIID)) {
            accessory.getService(Service.Lightbulb).getCharacteristic(Characteristic.Brightness)
               .on("set", function (value, callback) {
                  if (value > 0) {
                     if (!accessory.getService(Service.Lightbulb).getCharacteristic(Characteristic.On).value) {
                        platform.internalLightbulbUpdate(accessory, true, callback);
                     }
                     if (accessory.getService(Service.Lightbulb).getCharacteristic(Characteristic.Brightness).value !== value) {
                        platform.internalBrightnessUpdate(accessory, value, callback);
                     } else {
                        callback();
                     }
                  } else {
                     if (accessory.getService(Service.Lightbulb).getCharacteristic(Characteristic.On).value) {
                        platform.internalLightbulbUpdate(accessory, false, callback);
                     } else {
                        callback();
                     }
                  }
               });
         } else if (platform.devicesColourable.includes(accessory.context.eweUIID)) {
            accessory.getService(Service.Lightbulb).getCharacteristic(Characteristic.Brightness)
               .on("set", function (value, callback) {
                  if (value > 0) {
                     if (!accessory.getService(Service.Lightbulb).getCharacteristic(Characteristic.On).value) {
                        platform.internalLightbulbUpdate(accessory, true, callback);
                     }
                     if (accessory.getService(Service.Lightbulb).getCharacteristic(Characteristic.Brightness).value !== value) {
                        platform.internalHSBUpdate(accessory, "bri", value, callback);
                     } else {
                        callback();
                     }
                  } else {
                     if (accessory.getService(Service.Lightbulb).getCharacteristic(Characteristic.On).value) {
                        platform.internalLightbulbUpdate(accessory, false, callback);
                     } else {
                        callback();
                     }
                  }
               });
            accessory.getService(Service.Lightbulb).getCharacteristic(Characteristic.Hue)
               .on("set", function (value, callback) {
                  if (accessory.getService(Service.Lightbulb).getCharacteristic(Characteristic.Hue).value !== value) {
                     platform.internalHSBUpdate(accessory, "hue", value, callback);
                  } else {
                     callback();
                  }
               });
            accessory.getService(Service.Lightbulb).getCharacteristic(Characteristic.Saturation)
               .on("set", function (value, callback) {
                  accessory.getService(Service.Lightbulb).updateCharacteristic(Characteristic.Saturation, value);
                  callback();
               });
         }
      } else if (accessory.getService(Service.Switch)) {
         accessory.getService(Service.Switch).getCharacteristic(Characteristic.On)
            .on("set", function (value, callback) {
               platform.internalSwitchUpdate(accessory, value, callback);
            });
      } else if (accessory.getService(Service.MotionSensor)) {
         accessory.getService(Service.MotionSensor).setCharacteristic(Characteristic.MotionDetected, false);
      } else {
         platform.log.warn("[%s] could not be refreshed due to unknown accessory type.", accessory.displayName);
         return;
      }
      accessory.reachable = true;
      platform.devicesInHB.set(accessory.context.hbDeviceId, accessory);
   }
   
   removeAccessory(accessory) {
      try {
         platform.devicesInHB.delete(accessory.context.hbDeviceId);
         platform.api.unregisterPlatformAccessories("homebridge-ewelink-sonoff", "eWeLink", [accessory]);
         if (platform.debug) platform.log("[%s] has been removed from Homebridge.", accessory.displayName);
      } catch (e) {
         platform.log.warn("[%s] has not been removed - [%s].", accessory.displayName, e);
      }
   }
   
   internalBlindUpdate(accessory, value, callback) {
      platform.log("[%s] setting new target position to [%s].", accessory.displayName, value);
      let cPos = accessory.getService(Service.WindowCovering).getCharacteristic(Characteristic.CurrentPosition).value;
      let tPos = accessory.getService(Service.WindowCovering).getCharacteristic(Characteristic.TargetPosition).value;
      let cSte = accessory.getService(Service.WindowCovering).getCharacteristic(Characteristic.PositionState).value;
      let timestamp = Date.now();
      let payload = {
         apikey: accessory.context.eweApiKey,
         deviceid: accessory.context.hbDeviceId,
         params: {
            lock: 0,
            zyx_clear_timers: false,
            configure: [{
                  "startup": "off",
                  "outlet": 0
               },
               {
                  "startup": "off",
                  "outlet": 1
               },
               {
                  "startup": "off",
                  "outlet": 2
               },
               {
                  "startup": "off",
                  "outlet": 3
               }
            ],
            "pulses": [{
                  "pulse": "off",
                  "width": 1000,
                  "outlet": 0
               },
               {
                  "pulse": "off",
                  "width": 1000,
                  "outlet": 1
               },
               {
                  "pulse": "off",
                  "width": 1000,
                  "outlet": 2
               },
               {
                  "pulse": "off",
                  "width": 1000,
                  "outlet": 3
               }
            ],
            "switches": [{
                  "switch": "off",
                  "outlet": 0
               },
               {
                  "switch": "off",
                  "outlet": 1
               },
               {
                  "switch": "off",
                  "outlet": 2
               },
               {
                  "switch": "off",
                  "outlet": 3
               }
            ]
         }
      };
      if (cSte < 2) { // ie it's currently moving [either up or down]
         let diffPosition = Math.abs(value - tPos);
         let actualPosition = value;
         let diffTime = 0;
         let diff = 0;
         if (diffPosition > 0) {
            if (cSte === 1) {
               diffPosition = tPos - value;
               diffTime = Math.round(accessory.context.percentDurationDown * diffPosition);
               actualPosition = Math.round(cPos - ((timestamp - accessory.context.startTimestamp) / accessory.context.percentDurationDown));
            } else {
               diffPosition = value - tPos;
               diffTime = Math.round(accessory.context.percentDurationUp * diffPosition);
               actualPosition = Math.round(cPos + ((timestamp - accessory.context.startTimestamp) / accessory.context.percentDurationUp));
            }
            diff = (accessory.context.targetTimestamp - timestamp) + diffTime;
            if (diff > 0) {
               accessory.context.targetTimestamp += diffTime;
               if (value === 0 || value === 100) accessory.context.targetTimestamp += accessory.context.fullOverdrive;
               accessory.getService(Service.WindowCovering).updateCharacteristic(Characteristic.TargetPosition, value);
               callback();
               return;
            }
            if (diff < 0) {
               accessory.context.startTimestamp = timestamp;
               accessory.context.targetTimestamp = timestamp + Math.abs(diff);
               if (value === 0 || value === 100) accessory.context.targetTimestamp += accessory.context.fullOverdrive;
               accessory.getService(Service.WindowCovering).updateCharacteristic(Characteristic.CurrentPosition, actualPosition);
               accessory.getService(Service.WindowCovering).updateCharacteristic(Characteristic.TargetPosition, value);
               accessory.getService(Service.WindowCovering).updateCharacteristic(Characteristic.PositionState, cSte === 0 ? 1 : 0);
               payload.params.switches[accessory.context.switchUp].switch = cSte === 1 ? "on" : "off";
               payload.params.switches[accessory.context.switchDown].switch = cSte === 0 ? "on" : "off";
               platform.wsSendMessage(payload, function () {
                  return;
               });
            }
            callback();
            return;
         }
         callback();
         return;
      }
      if (cPos === value) {
         callback();
         return;
      }
      accessory.getService(Service.WindowCovering).updateCharacteristic(Characteristic.TargetPosition, value);
      let moveUp = (value > cPos);
      let duration;
      if (moveUp) {
         duration = (value - cPos) / 100 * (accessory.context.durationUp - accessory.context.durationBMU);
         if (cPos === 0) duration += accessory.context.durationBMU;
      } else {
         duration = (cPos - value) / 100 * (accessory.context.durationDown - accessory.context.durationBMD);
         if (value === 0) duration += accessory.context.durationBMD;
      }
      if (value === 0 || value === 100) duration += accessory.context.fullOverdrive;
      duration = Math.round(duration * 100) / 100;
      accessory.context.startTimestamp = timestamp;
      accessory.context.targetTimestamp = timestamp + (duration * 1000);
      accessory.getService(Service.WindowCovering).updateCharacteristic(Characteristic.PositionState, moveUp ? 0 : 1);
      payload.params.switches[accessory.context.switchUp].switch = moveUp ? "on" : "off";
      payload.params.switches[accessory.context.switchDown].switch = moveUp ? "off" : "on";
      platform.wsSendMessage(payload, function () {
         return;
      });
      let interval = setInterval(function () {
         if (Date.now() >= accessory.context.targetTimestamp) {
            accessory.getService(Service.WindowCovering).updateCharacteristic(Characteristic.PositionState, 2);
            payload.params.switches[accessory.context.switchUp].switch = "off";
            payload.params.switches[accessory.context.switchDown].switch = "off";
            setTimeout(function () {
               platform.wsSendMessage(payload, function () {
                  return;
               });
               accessory.getService(Service.WindowCovering).updateCharacteristic(Characteristic.CurrentPosition, value);
               return;
            }, 500);
            clearInterval(interval);
            return;
         }
      }, 100);
      callback();
   }
   
   internalFanUpdate(accessory, type, value, callback) {
      let newPower;
      let newSpeed;
      let newLight;
      switch (type) {
      case "power":
         newPower = value;
         newSpeed = value ? 33 : 0;
         newLight = accessory.getService(Service.Lightbulb).getCharacteristic(Characteristic.On).value;
         break;
      case "speed":
         newPower = value >= 33;
         newSpeed = value;
         newLight = accessory.getService(Service.Lightbulb).getCharacteristic(Characteristic.On).value;
         break;
      case "light":
         newPower = accessory.getService(Service.Fanv2).getCharacteristic(Characteristic.On).value;
         newSpeed = accessory.getService(Service.Fanv2).getCharacteristic(Characteristic.RotationSpeed).value;
         newLight = value;
         break;
      }
      let payload = {
         apikey: accessory.context.eweApiKey,
         deviceid: accessory.context.eweDeviceId,
         params: {}
      };
      payload.params.switches = platform.devicesInEwe.get(accessory.context.eweDeviceId).params.switches;
      payload.params.switches[0].switch = newLight ? "on" : "off";
      payload.params.switches[1].switch = newSpeed >= 33 ? "on" : "off";
      payload.params.switches[2].switch = newSpeed >= 66 && newSpeed < 99 ? "on" : "off";
      payload.params.switches[3].switch = newSpeed >= 99 ? "on" : "off";
      if (platform.debug) platform.log("[%s] requesting to change fan %s.", accessory.displayName, type);
      accessory.getService(Service.Lightbulb).updateCharacteristic(Characteristic.On, newLight);
      accessory.getService(Service.Fanv2).updateCharacteristic(Characteristic.On, newPower);
      accessory.getService(Service.Fanv2).updateCharacteristic(Characteristic.RotationSpeed, newSpeed);
      platform.wsSendMessage(payload, callback);
   }
   
   internalThermostatUpdate(accessory, value, callback) {
      let payload = {
         apikey: accessory.context.eweApiKey,
         deviceid: accessory.context.eweDeviceId,
         params: {
            switch: value ? "on" : "off",
            mainSwitch: value ? "on" : "off"
         }
      };
      if (platform.debug) platform.log("[%s] requesting to turn switch [%s].", accessory.displayName, value ? "on" : "off");
      accessory.getService(Service.Switch).updateCharacteristic(Characteristic.On, value);
      platform.wsSendMessage(payload, callback);
   }
   
   internalOutletUpdate(accessory, value, callback) {
      let payload = {
         apikey: accessory.context.eweApiKey,
         deviceid: accessory.context.eweDeviceId,
         params: {
            switch: value ? "on" : "off"
         }
      };
      if (platform.debug) platform.log("[%s] requesting to turn [%s].", accessory.displayName, value ? "on" : "off");
      accessory.getService(Service.Outlet).updateCharacteristic(Characteristic.On, value);
      platform.wsSendMessage(payload, callback);
   }
   
   internalLightbulbUpdate(accessory, value, callback) {
      let otherAccessory;
      let i;
      let payload = {
         apikey: accessory.context.eweApiKey,
         deviceid: accessory.context.eweDeviceId,
         params: {}
      };
      switch (accessory.context.switchNumber) {
      case "X":
         if (accessory.context.eweUIID === 22) { // The B1 uses state instead of switch for some strange reason.
            payload.params.state = value ? "on" : "off";
         } else {
            payload.params.switch = value ? "on" : "off";
         }
         if (platform.debug) platform.log("[%s] requesting to turn [%s].", accessory.displayName, value ? "on" : "off");
         accessory.getService(Service.Lightbulb).updateCharacteristic(Characteristic.On, value);
         break;
      case "0":
         payload.params.switches = platform.devicesInEwe.get(accessory.context.eweDeviceId).params.switches;
         payload.params.switches[0].switch = value ? "on" : "off";
         payload.params.switches[1].switch = value ? "on" : "off";
         payload.params.switches[2].switch = value ? "on" : "off";
         payload.params.switches[3].switch = value ? "on" : "off";
         if (platform.debug) platform.log("[%s] requesting to turn group [%s].", accessory.displayName, value ? "on" : "off");
         accessory.getService(Service.Lightbulb).updateCharacteristic(Characteristic.On, value);
         for (i = 1; i <= 4; i++) {
            if (platform.devicesInHB.has(accessory.context.eweDeviceId + "SW" + i)) {
               otherAccessory = platform.devicesInHB.get(accessory.context.eweDeviceId + "SW" + i);
               otherAccessory.getService(Service.Lightbulb).updateCharacteristic(Characteristic.On, value);
            }
         }
         break;
      case "1":
      case "2":
      case "3":
      case "4":
         payload.params.switches = platform.devicesInEwe.get(accessory.context.eweDeviceId).params.switches;
         payload.params.switches[parseInt(accessory.context.switchNumber) - 1].switch = value ? "on" : "off";
         accessory.getService(Service.Lightbulb).updateCharacteristic(Characteristic.On, value);
         let ch = false;
         let masterState = "off";
         for (i = 1; i <= 4; i++) {
            if (platform.devicesInHB.has(accessory.context.eweDeviceId + "SW" + i)) {
               ch = platform.devicesInHB.get(accessory.context.eweDeviceId + "SW" + i).getService(Service.Lightbulb).getCharacteristic(Characteristic.On).value;
               if (ch) {
                  masterState = "on";
               }
            }
         }
         if (platform.debug) platform.log("[%s] requesting to turn [%s].", accessory.displayName, value ? "on" : "off");
         otherAccessory = platform.devicesInHB.get(accessory.context.eweDeviceId + "SW0");
         otherAccessory.getService(Service.Lightbulb).updateCharacteristic(Characteristic.On, masterState === "on");
         break;
      default:
         callback();
         return;
      }
      platform.wsSendMessage(payload, callback);
   }
   
   internalBrightnessUpdate(accessory, value, callback) {
      let payload = {
         apikey: accessory.context.eweApiKey,
         deviceid: accessory.context.eweDeviceId,
         params: {}
      };
      if (value === 0) {
         payload.params.switch = "off";
         accessory.getService(Service.Lightbulb).updateCharacteristic(Characteristic.On, false);
      } else {
         if (!accessory.getService(Service.Lightbulb).getCharacteristic(Characteristic.On).value) {
            payload.params.switch = "on";
         }
         
         if (accessory.context.eweUIID === 36) { // KING-M4
            payload.params.bright = Math.round(value * 9 / 10 + 10);
         } else if (accessory.context.eweUIID === 44) { // D1
            payload.params.brightness = value;
            payload.params.mode = 0;
         } else {
            callback();
            return;
         }
         accessory.getService(Service.Lightbulb).updateCharacteristic(Characteristic.Brightness, value);
      }
      if (platform.debug) platform.log("[%s] requesting to turn brightness to [%s%].", accessory.displayName, value);
      setTimeout(function () {
         platform.wsSendMessage(payload, callback);
      }, 250);
   }
   
   internalHSBUpdate(accessory, type, value, callback) {
      let newRGB;
      let curHue;
      let curSat;
      let payload = {
         apikey: accessory.context.eweApiKey,
         deviceid: accessory.context.eweDeviceId,
         params: {}
      };
      switch (type) {
      case "hue":
         curSat = accessory.getService(Service.Lightbulb).getCharacteristic(Characteristic.Saturation).value;
         newRGB = convert.hsv.rgb(value, curSat, 100);
         if ((accessory.context.eweUIID === 22)) { // B1
            payload.params.zyx_mode = 2;
            payload.params.channel2 = newRGB[0];
            payload.params.channel3 = newRGB[1];
            payload.params.channel4 = newRGB[2];
         } else if (accessory.context.eweUIID === 59) { // L1
            payload.params.mode = 1;
            payload.params.colorR = newRGB[0];
            payload.params.colorG = newRGB[1];
            payload.params.colorB = newRGB[2];
         } else {
            callback();
            return;
         }
         if (platform.debug) platform.log("[%s] requesting to change hue to [%s].", accessory.displayName, value);
         accessory.getService(Service.Lightbulb).updateCharacteristic(Characteristic.Hue, value);
         break;
      case "bri":
         curHue = accessory.getService(Service.Lightbulb).getCharacteristic(Characteristic.Hue).value;
         curSat = accessory.getService(Service.Lightbulb).getCharacteristic(Characteristic.Saturation).value;
         if (accessory.context.eweUIID === 22) { // B1
            newRGB = convert.hsv.rgb(curHue, curSat, value);
            payload.params.zyx_mode = 2;
            payload.params.channel2 = newRGB[0];
            payload.params.channel3 = newRGB[1];
            payload.params.channel4 = newRGB[2];
         } else if (accessory.context.eweUIID === 59) { // L1
            payload.params.mode = 1;
            payload.params.bright = value;
         } else {
            callback();
            return;
         }
         if (platform.debug) platform.log("[%s] requesting to change brightness to [%s%].", accessory.displayName, value);
         accessory.getService(Service.Lightbulb).updateCharacteristic(Characteristic.Brightness, value);
         break;
      }
      setTimeout(function () {
         platform.wsSendMessage(payload, callback);
      }, 250);
   }
   
   internalSwitchUpdate(accessory, value, callback) {
      let otherAccessory;
      let i;
      let payload = {
         apikey: accessory.context.eweApiKey,
         deviceid: accessory.context.eweDeviceId,
         params: {}
      };
      switch (accessory.context.switchNumber) {
      case "X":
         payload.params.switch = value ? "on" : "off";
         if (platform.debug) platform.log("[%s] requesting to turn [%s].", accessory.displayName, value ? "on" : "off");
         accessory.getService(Service.Switch).updateCharacteristic(Characteristic.On, value);
         break;
      case "0":
         payload.params.switches = platform.devicesInEwe.get(accessory.context.eweDeviceId).params.switches;
         payload.params.switches[0].switch = value ? "on" : "off";
         payload.params.switches[1].switch = value ? "on" : "off";
         payload.params.switches[2].switch = value ? "on" : "off";
         payload.params.switches[3].switch = value ? "on" : "off";
         if (platform.debug) platform.log("[%s] requesting to turn group [%s].", accessory.displayName, value ? "on" : "off");
         accessory.getService(Service.Switch).updateCharacteristic(Characteristic.On, value);
         for (i = 1; i <= 4; i++) {
            if (platform.devicesInHB.has(accessory.context.eweDeviceId + "SW" + i)) {
               otherAccessory = platform.devicesInHB.get(accessory.context.eweDeviceId + "SW" + i);
               otherAccessory.getService(Service.Switch).updateCharacteristic(Characteristic.On, value);
            }
         }
         break;
      case "1":
      case "2":
      case "3":
      case "4":
         payload.params.switches = platform.devicesInEwe.get(accessory.context.eweDeviceId).params.switches;
         payload.params.switches[parseInt(accessory.context.switchNumber) - 1].switch = value ? "on" : "off";
         if (platform.debug) platform.log("[%s] requesting to turn [%s].", accessory.displayName, value ? "on" : "off");
         accessory.getService(Service.Switch).updateCharacteristic(Characteristic.On, value);
         let ch = false;
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
         otherAccessory.getService(Service.Switch).updateCharacteristic(Characteristic.On, masterState === "on");
         break;
      default:
         callback();
         return;
      }
      platform.wsSendMessage(payload, callback);
   }
   
   externalBlindUpdate(hbDeviceId, params) {
      let accessory = platform.devicesInHB.get(hbDeviceId);
      let cPos = accessory.getService(Service.WindowCovering).getCharacteristic(Characteristic.CurrentPosition).value;
      let tPos = accessory.getService(Service.WindowCovering).getCharacteristic(Characteristic.TargetPosition).value;
      let cSte = accessory.getService(Service.WindowCovering).getCharacteristic(Characteristic.PositionState).value;
      let switchUp = params.switches[accessory.context.switchUp].switch === "on" ? 2 : 0;
      let switchDown = params.switches[accessory.context.switchDown].switch === "on" ? 1 : 0;
      let state;
      switch (switchUp + switchDown) {
      case 0:
      default:
         state = 2; // stopped or error
         break;
      case 1:
         state = 1; // moving down
         break;
      case 2:
         state = 0; // moving up
         break;
      }
      accessory.getService(Service.WindowCovering).updateCharacteristic(Characteristic.PositionState, state);
      switch (state) {
      case 3:
      case 2:
      default:
         let timestamp = Date.now();
         if (cSte === 2) {
            return;
         } else if (cSte === 1) {
            cPos = Math.round(cPos - ((timestamp - accessory.context.startTimestamp) / accessory.context.percentDurationDown));
         } else if (cSte === 0) {
            cPos = Math.round(cPos + ((timestamp - accessory.context.startTimestamp) / accessory.context.percentDurationUp));
         }
         accessory.context.targetTimestamp = Date.now() + 10;
         accessory.getService(Service.WindowCovering).updateCharacteristic(Characteristic.TargetPosition, cPos);
         break;
      case 1:
         if (cSte === 1) {
            return;
         }
         if (tPos !== 0) {
            accessory.getService(Service.WindowCovering).updateCharacteristic(Characteristic.TargetPosition, 0);
         }
         break;
      case 0:
         if (cSte === 0) {
            return;
         }
         if (tPos != 100) {
            accessory.getService(Service.WindowCovering).updateCharacteristic(Characteristic.TargetPosition, 100);
         }
         break;
      }
      if ((state === 0 && tPos === 0) || (state === 1 && tPos === 100)) {
         accessory.getService(Service.WindowCovering).updateCharacteristic(Characteristic.CurrentPosition, tPos);
         accessory.getService(Service.WindowCovering).updateCharacteristic(Characteristic.TargetPosition, tPos);
         accessory.getService(Service.WindowCovering).updateCharacteristic(Characteristic.PositionState, 2);
      }
      return;
   }
   
   externalFanUpdate(hbDeviceId, params) {
      let accessory = platform.devicesInHB.get(hbDeviceId);
      accessory.getService(Service.Lightbulb).updateCharacteristic(Characteristic.On, params.switches[0].switch === "on");
      let status = false;
      let speed = 0;
      if (params.switches[1].switch === "on" && params.switches[2].switch === "off" && params.switches[3].switch === "off") {
         status = true;
         speed = 33;
      } else if (params.switches[1].switch === "on" && params.switches[2].switch === "on" && params.switches[3].switch === "off") {
         status = true;
         speed = 66;
      } else if (params.switches[1].switch === "on" && params.switches[2].switch === "off" && params.switches[3].switch === "on") {
         status = true;
         speed = 100;
      }
      accessory.getService(Service.Fanv2).updateCharacteristic(Characteristic.On, status);
      accessory.getService(Service.Fanv2).updateCharacteristic(Characteristic.RotationSpeed, speed);
      return;
   }
   
   externalThermostatUpdate(hbDeviceId, params) {
      let accessory = platform.devicesInHB.get(hbDeviceId);
      if (params.hasOwnProperty("switch") || params.hasOwnProperty("mainSwitch")) {
         let newState;
         if (params.hasOwnProperty("switch")) {
            newState = params.switch === "on";
         } else {
            newState = params.mainSwitch === "on";
         }
         accessory.getService(Service.Switch).updateCharacteristic(Characteristic.On, newState);
      }
      if (params.hasOwnProperty("currentTemperature") && accessory.getService(Service.TemperatureSensor)) {
         let currentTemp = params.currentTemperature !== "unavailable" ? params.currentTemperature : 0;
         accessory.getService(Service.TemperatureSensor).updateCharacteristic(Characteristic.CurrentTemperature, currentTemp);
      }
      if (params.hasOwnProperty("currentHumidity") && accessory.getService(Service.HumiditySensor)) {
         let currentHumi = params.currentHumidity !== "unavailable" ? params.currentHumidity : 0;
         accessory.getService(Service.HumiditySensor).updateCharacteristic(Characteristic.CurrentRelativeHumidity, currentHumi);
      }
      return;
   }
   
   externalOutletUpdate(hbDeviceId, params) {
      let accessory = platform.devicesInHB.get(hbDeviceId);
      accessory.getService(Service.Outlet).updateCharacteristic(Characteristic.On, params.switch === "on");
      return;
   }
   
   externalSingleLightUpdate(hbDeviceId, params) {
      let accessory = platform.devicesInHB.get(hbDeviceId);
      let newColour;
      let mode;
      let isOn = false;
      if ((accessory.context.eweUIID === 22) && params.hasOwnProperty("state")) {
         isOn = params.state === "on";
      } else if (accessory.context.eweUIID !== 22 && params.hasOwnProperty("switch")) {
         isOn = params.switch === "on";
      } else {
         isOn = accessory.getService(Service.Lightbulb).getCharacteristic(Characteristic.On).value;
      }
      if (isOn) {
         accessory.getService(Service.Lightbulb).updateCharacteristic(Characteristic.On, true);
         
         switch (accessory.context.eweUIID) {
         case 36: // KING-M4
            if (params.hasOwnProperty("bright")) {
               // Device brightness has a eWeLink scale of 10-100 and HomeKit scale is 0-100.
               let nb = Math.round((params.bright - 10) * 10 / 9);
               accessory.getService(Service.Lightbulb).updateCharacteristic(Characteristic.Brightness, nb);
            }
            break;
         case 44: // D1
            if (params.hasOwnProperty("brightness")) {
               accessory.getService(Service.Lightbulb).updateCharacteristic(Characteristic.Brightness, params.brightness);
            }
            break;
         case 22: // B1
            if (params.hasOwnProperty("zyx_mode")) { // B1
               mode = parseInt(params.zyx_mode);
            } else if (params.hasOwnProperty("channel0")) {
               mode = 1;
            } else if (params.hasOwnProperty("channel2")) {
               mode = 2;
            } else {
               mode = 0;
            }
            if (mode === 2) {
               accessory.getService(Service.Lightbulb).updateCharacteristic(Characteristic.On, true);
               newColour = convert.rgb.hsv(parseInt(params.channel2), parseInt(params.channel3), parseInt(params.channel4));
               // The eWeLink app only supports hue change in app so set saturation and brightness to 100.
               accessory.getService(Service.Lightbulb).updateCharacteristic(Characteristic.Hue, newColour[0]);
               accessory.getService(Service.Lightbulb).updateCharacteristic(Characteristic.Saturation, 100);
               accessory.getService(Service.Lightbulb).updateCharacteristic(Characteristic.Brightness, 100);
            } else {
               platform.log.warn("[%s] has been set to 'white mode' which is not supported by this plugin.", accessory.displayName);
            }
            break;
         case 59: // L1
            if (params.hasOwnProperty("bright")) {
               accessory.getService(Service.Lightbulb).updateCharacteristic(Characteristic.Brightness, params.bright);
            }
            if (params.hasOwnProperty("colorR")) {
               newColour = convert.rgb.hsv(params.colorR, params.colorG, params.colorB);
               accessory.getService(Service.Lightbulb).updateCharacteristic(Characteristic.Hue, newColour[0]);
               accessory.getService(Service.Lightbulb).updateCharacteristic(Characteristic.Saturation, newColour[1]);
            }
            break;
         default:
            return;
         }
      } else {
         accessory.getService(Service.Lightbulb).updateCharacteristic(Characteristic.On, false);
      }
      return;
   }
   
   externalMultiLightUpdate(hbDeviceId, params) {
      let accessory = platform.devicesInHB.get(hbDeviceId);
      let idToCheck = hbDeviceId.slice(0, -1);
      let i;
      let primaryState = false;
      let otherAccessory;
      for (i = 1; i <= accessory.context.channelCount; i++) {
         if (platform.devicesInHB.has(idToCheck + i)) {
            otherAccessory = platform.devicesInHB.get(idToCheck + i);
            if (platform.debug) platform.log("[%s] has been found in Homebridge so refresh status.", otherAccessory.displayName);
            otherAccessory.getService(Service.AccessoryInformation).setCharacteristic(Characteristic.FirmwareRevision, params.fwVersion);
            otherAccessory.reachable = true;
            otherAccessory.getService(Service.Lightbulb).updateCharacteristic(Characteristic.On, params.switches[i - 1].switch === "on");
            if (params.switches[i - 1].switch === "on") primaryState = true;
         }
         accessory.getService(Service.Lightbulb).updateCharacteristic(Characteristic.On, primaryState);
      }
      return;
   }
   
   externalSingleSwitchUpdate(hbDeviceId, params) {
      let accessory = platform.devicesInHB.get(hbDeviceId);
      accessory.getService(Service.Switch).updateCharacteristic(Characteristic.On, params.switch === "on");
      return;
   }
   
   externalMultiSwitchUpdate(hbDeviceId, params) {
      let accessory = platform.devicesInHB.get(hbDeviceId);
      let idToCheck = hbDeviceId.slice(0, -1);
      let i;
      let primaryState = false;
      let otherAccessory;
      for (i = 1; i <= accessory.context.channelCount; i++) {
         if (platform.devicesInHB.has(idToCheck + i)) {
            otherAccessory = platform.devicesInHB.get(idToCheck + i);
            if (platform.debug) platform.log("[%s] has been found in Homebridge so refresh status.", otherAccessory.displayName);
            otherAccessory.getService(Service.AccessoryInformation).setCharacteristic(Characteristic.FirmwareRevision, params.fwVersion);
            otherAccessory.getService(Service.Switch).updateCharacteristic(Characteristic.On, params.switches[i - 1].switch === "on");
            if (params.switches[i - 1].switch === "on") primaryState = true;
         }
         accessory.getService(Service.Switch).updateCharacteristic(Characteristic.On, primaryState);
      }
      return;
   }
   
   externalBridgeUpdate(hbDeviceId, params) {
      let accessory = platform.devicesInHB.get(hbDeviceId);
      let idToCheck = hbDeviceId.slice(0, -1);
      let timeNow = new Date();
      let timeOfMotion;
      let timeDifference;
      let i;
      let otherAccessory;
      let master = false;
      for (i = 1; i <= accessory.context.channelCount; i++) {
         if (platform.devicesInHB.has(idToCheck + i)) {
            otherAccessory = platform.devicesInHB.get(idToCheck + i);
            if (params.hasOwnProperty("rfTrig" + (i - 1))) {
               timeOfMotion = new Date(params["rfTrig" + (i - 1)]);
               timeDifference = (timeNow.getTime() - timeOfMotion.getTime()) / 1000;
               if (timeDifference < platform.sensorTimeDifference) {
                  otherAccessory.getService(Service.MotionSensor).updateCharacteristic(Characteristic.MotionDetected, true);
                  master = true;
                  if (platform.debug) platform.log("[%s] has detected motion.", otherAccessory.displayName);
               }
            }
         }
         accessory.getService(Service.MotionSensor).updateCharacteristic(Characteristic.MotionDetected, master);
      }
      setTimeout(() => {
         for (i = 0; i <= accessory.context.channelCount; i++) {
            if (platform.devicesInHB.has(idToCheck + i)) {
               otherAccessory = platform.devicesInHB.get(idToCheck + i);
               otherAccessory.getService(Service.MotionSensor).updateCharacteristic(Characteristic.MotionDetected, false);
            }
         }
      }, platform.sensorTimeLength * 1000);
      return;
   }
   
   helperChannelsByUIID(uiid) {
      const UIID_TO_CHAN = {
         1: 1, // "SOCKET"                                 \\ 20, MINI, BASIC, S26
         2: 2, // "SOCKET_2"                               \\ 
         3: 3, // "SOCKET_3"                               \\ 
         4: 4, // "SOCKET_4",                              \\ 
         5: 1, // "SOCKET_POWER"                           \\ 
         6: 1, // "SWITCH"                                 \\ T1 1C, TX1C
         7: 2, // "SWITCH_2"                               \\ T1 2C, TX2C
         8: 3, // "SWITCH_3"                               \\ T1 3C, TX3C
         9: 4, // "SWITCH_4"                               \\ 
         10: 0, // "OSPF"                                   \\ 
         11: 0, // "CURTAIN"                                \\ 
         12: 0, // "EW-RE"                                  \\ 
         13: 0, // "FIREPLACE"                              \\ 
         14: 1, // "SWITCH_CHANGE"                          \\ 
         15: 1, // "THERMOSTAT"                             \\ TH10, TH16
         16: 0, // "COLD_WARM_LED"                          \\ 
         17: 0, // "THREE_GEAR_FAN"                         \\ 
         18: 0, // "SENSORS_CENTER"                         \\ 
         19: 0, // "HUMIDIFIER"                             \\ 
         22: 1, // "RGB_BALL_LIGHT"                         \\ B1, B1_R2
         23: 0, // "NEST_THERMOSTAT"                        \\ 
         24: 1, // "GSM_SOCKET"                             \\
         25: 0, // "AROMATHERAPY",                          \\
         26: 0, // "BJ_THERMOSTAT",                         \\
         27: 1, // "GSM_UNLIMIT_SOCKET"                     \\
         28: 1, // "RF_BRIDGE"                              \\ RFBridge, RF_Bridge
         29: 2, // "GSM_SOCKET_2"                           \\
         30: 3, // "GSM_SOCKET_3"                           \\
         31: 4, // "GSM_SOCKET_4"                           \\
         32: 1, // "POWER_DETECTION_SOCKET"                 \\ Pow_R2 POW
         33: 0, // "LIGHT_BELT",                            \\
         34: 4, // "FAN_LIGHT"                              \\ iFan02, iFan
         35: 0, // "EZVIZ_CAMERA",                          \\
         36: 1, // "SINGLE_CHANNEL_DIMMER_SWITCH"           \\ KING-M4
         38: 0, // "HOME_KIT_BRIDGE",                       \\
         40: 0, // "FUJIN_OPS"                              \\
         41: 4, // "CUN_YOU_DOOR"                           \\
         42: 0, // "SMART_BEDSIDE_AND_NEW_RGB_BALL_LIGHT"   \\ 
         43: 0, // "?"                                      \\ 
         44: 1, // "(the sonoff dimmer)"                    \\ D1
         45: 0, // "DOWN_CEILING_LIGHT"
         46: 0, // "AIR_CLEANER"
         49: 0, // "MACHINE_BED"
         51: 0, // "COLD_WARM_DESK_LIGHT",
         52: 0, // "DOUBLE_COLOR_DEMO_LIGHT"
         53: 0, // "ELECTRIC_FAN_WITH_LAMP"
         55: 0, // "SWEEPING_ROBOT"
         56: 0, // "RGB_BALL_LIGHT_4"
         57: 0, // "MONOCHROMATIC_BALL_LIGHT"
         59: 1, // "MEARICAMERA"                            \\ L1
         77: 4, // "MICRO"
         87: 0, // "(the sonoff camera)"                    \\ GK-200MP2B
         102: 0, // "(the door opener??)"                    \\ OPL-DMA
         1001: 0, // "BLADELESS_FAN"
         1002: 0, // "NEW_HUMIDIFIER",
         1003: 0 // "WARM_AIR_BLOWER"
      };
      return UIID_TO_CHAN[uiid] || 0;
   }
   
   helperGetSignature(string) {
      return crypto.createHmac("sha256", "6Nz4n0xA8s8qdxQf2GqurZj2Fs55FUvM").update(string).digest("base64");
   }
   
   httpGetRegion(callback) {
      let data = {
         "country_code": platform.config.countryCode,
         "version": 8,
         "ts": Math.floor(new Date().getTime() / 1000),
         "nonce": nonce(),
         "appid": platform.appid
      };
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
      }).join("&");
      
      axios.get("https://api.coolkit.cc:8080/api/user/region", {
         params: data,
         headers: {
            "Authorization": "Sign " + platform.helperGetSignature(dataToSign),
            "Content-Type": "application/json;charset=UTF-8"
         }
      }).then((res) => {
         let body = res.data;
         
         if (!body.region) {
            platform.log.error("Server did not response with a region.");
            platform.log.warn("\n" + JSON.stringify(body, null, 2));
            callback();
            return;
         }
         let idx = platform.apiHost.indexOf("-");
         if (idx === -1) {
            platform.log.error("Received region [%s]. However we cannot construct the new API host url.", body.region);
            callback();
            return;
         }
         let newApiHost = body.region + platform.apiHost.substring(idx);
         if (platform.apiHost !== newApiHost) {
            if (platform.debug) platform.log("Received region [%s], updating API host to [%s].", body.region, newApiHost);
            platform.apiHost = newApiHost;
         }
         callback(body.region);
         return;
      }).catch(function (error) {
         platform.log.error("****************************************************************************");
         platform.log.warn("Unable to connect to eWeLink, so homebridge-ewelink-sonoff cannot be loaded.");
         platform.log.warn("Please verify that your Homebridge instance is connected to the internet....");
         platform.log.error("****************************************************************************");
         callback();
         return;
      }.bind(platform));
   }
   
   httpLogin(callback) {
      let data = {};
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
      axios({
         method: "post",
         url: "https://" + platform.apiHost + "/api/user/login",
         data: data,
         headers: {
            "Authorization": "Sign " + platform.helperGetSignature(JSON.stringify(data)),
            "Content-Type": "application/json;charset=UTF-8"
         }
      }).then((res) => {
         let body = res.data;
         if (!body.at) throw JSON.stringify(body, null, 2);
         if (body.hasOwnProperty("error") && body.error === 301 && body.hasOwnProperty("region")) {
            let idx = platform.apiHost.indexOf("-");
            if (idx === -1) throw "Cannot construct the new API host url.";
            let newApiHost = body.region + platform.apiHost.substring(idx);
            if (platform.apiHost !== newApiHost) {
               if (platform.debug) platform.log("Received new region [%s], updating API host to [%s].", body.region, newApiHost);
               platform.apiHost = newApiHost;
               platform.httpLogin(callback);
               return;
            }
         }
         platform.authenticationToken = body.at;
         platform.apiKey = body.user.apikey;
         platform.wsGetHost(function () {
            callback(body.at);
         }.bind(platform));
      }).catch(function (error) {
         platform.log.error("****** An error occurred while logging in. ******");
         platform.log.warn("[%s].", error);
         callback();
         return;
      }.bind(platform));
   }
   
   wsGetHost(callback) {
      axios({
         method: "post",
         url: "https://" + platform.apiHost.replace("-api", "-disp") + "/dispatch/app",
         data: {
            accept: "mqtt,ws",
            version: 8,
            ts: Math.floor(new Date().getTime() / 1000),
            nonce: nonce(),
            appid: platform.appid
         },
         headers: {
            "Authorization": "Bearer " + platform.authenticationToken,
            "Content-Type": "application/json;charset=UTF-8"
         }
      }).then((res) => {
         let body = res.data;
         if (!body.domain) throw "Server did not response with a web socket host.";
         if (platform.debug) platform.log("Web socket host received [%s].", body.domain);
         platform.wsHost = body.domain;
         if (platform.ws) {
            platform.ws.url = "wss://" + body.domain + ":8080/api/ws";
         }
         callback(body.domain);
         return;
      }).catch(function (error) {
         platform.log.error("****** An error occurred while getting web socket host. ******");
         platform.log.warn("[%s].", error);
         callback();
         return;
      }.bind(platform));
   }
   
   wsSendMessage(json, callback) {
      json.sequence = Math.floor(new Date());
      json.action = "update";
      json.userAgent = "app";
      let string = JSON.stringify(json);
      platform.delaySend = 0;
      const delayOffset = 280;
      let sendOperation = (string) => {
         if (!platform.wsIsOpen) {
            setTimeout(() => {
               sendOperation(string);
            }, delayOffset);
            return;
         }
         if (platform.ws) {
            try {
               platform.ws.send(string);
            } catch (e) {
               platform.ws.emit("error", e);
            }
            if (platform.debugReqRes) platform.log.warn("Web socket message sent.\n" + JSON.stringify(json, null, 2));
            else if (platform.debug) platform.log("Web socket message sent.");
            callback();
         }
         platform.delaySend = platform.delaySend <= 0 ? 0 : platform.delaySend -= delayOffset;
      };
      if (!platform.wsIsOpen) {
         if (platform.debug) platform.log("Web socket is pending reconnection and will try in a few seconds.");
         let interval;
         let waitToSend = (string) => {
            if (platform.wsIsOpen) {
               clearInterval(interval);
               sendOperation(string);
            }
         };
         interval = setInterval(waitToSend, 750, string);
      } else {
         setTimeout(sendOperation, platform.delaySend, string);
         platform.delaySend += delayOffset;
      }
   }
}

function WSC() {
   this.number = 0;
}
WSC.prototype.open = function (url) {
   this.url = url;
   this.instance = new ws(this.url);
   this.instance.on("open", () => {
      this.onopen();
   });
   this.instance.on("message", (data, flags) => {
      this.number++;
      this.onmessage(data, flags, this.number);
   });
   this.instance.on("close", (e) => {
      if (e.code !== 1000) {
         this.reconnect(e);
      }
      this.onclose(e);
   });
   this.instance.on("error", (e) => {
      if (e.code === "ECONNREFUSED") {
         this.reconnect(e);
      } else {
         this.onerror(e);
      }
   });
};
WSC.prototype.send = function (data, option) {
   try {
      this.instance.send(data, option);
   } catch (e) {
      this.instance.emit("error", e);
   }
};
WSC.prototype.reconnect = function (e) {
   this.instance.removeAllListeners();
   let that = this;
   setTimeout(function () {
      that.open(that.url);
   }, 2500);
};