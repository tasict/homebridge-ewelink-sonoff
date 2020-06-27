let WebSocket = require("ws");
let request = require("request-json");
let nonce = require("nonce")();
let crypto = require("crypto");
let convert = require("color-convert");
let ws;
let sequence;
let webClient;
let Accessory;
let Service;
let Characteristic;
let UUIDGen;
const querystring = require("querystring");

module.exports = function (homebridge) {
   Accessory = homebridge.platformAccessory;
   Service = homebridge.hap.Service;
   Characteristic = homebridge.hap.Characteristic;
   UUIDGen = homebridge.hap.uuid;
   homebridge.registerPlatform("homebridge-ewelink-sonoff", "eWeLink", eWeLink, true);
};

class eWeLink {
   constructor(log, config, api) {
      let platform = this;
      let check = true;
      platform.log = log;
      platform.config = config;
      if (!platform.config || (!platform.config.username || !platform.config.password || !platform.config.countryCode)) {
         platform.log.error("********************************************************************************************");
         platform.log.error("Please check you have set your username, password and country code in the Homebridge config.");
         platform.log.error("********************************************************************************************");
         return;
      }
      platform.apiKey = "UNCONFIGURED";
      platform.authenticationToken = "UNCONFIGURED";
      platform.appid = "oeVkj2lYFGnJu5XUtWisfW4utiN4u9Mq";
      platform.emailLogin = platform.config.username.includes("@") ? true : false;
      platform.apiHost = (platform.config.apiHost || "eu-api.coolkit.cc") + ":8080";
      platform.wsHost = platform.config.wsHost || "eu-pconnect3.coolkit.cc";
      platform.debug = platform.config.debug || false;
      platform.debugReqRes = platform.config.debugReqRes || false;
      platform.debugInitial = platform.config.debugInitial || false;
      platform.sensorTimeLength = platform.config.sensorTimeLength || 2;
      platform.sensorTimeDifference = platform.config.sensorTimeDifference || 120;
      platform.webSocketOpen = false;
      platform.devicesInHB = new Map();
      platform.devicesInEwe = new Map();
      platform.devicesUnsupported = [];
      // Supported single-switch UIIDs:
      platform.devicesSingleSwitch = [1, 5, 6, 14, 15, 22, 24, 27, 32, 36, 44, 59];
      // Supported single-switch models we can expose as lights:
      platform.devicesSingleSwitchLight = ["T1 1C", "L1", "B1", "B1_R2", "TX1C", "D1", "KING-M4", "Slampher"];
      // Supported multi-switch UIIDs:
      platform.devicesMultiSwitch = [2, 3, 4, 7, 8, 9, 29, 30, 31, 34, 41, 77];
      // Supported multi-switch models we can expose as lights:
      platform.devicesMultiSwitchLight = ["T1 2C", "T1 3C", "TX2C", "TX3C"];
      // Supported UIIDs that have a dimmer function:
      platform.devicesDimmable = [36, 44];
      // Supported UIIDs that can be changed colour (22:B1 and 59:L1):
      platform.devicesColourable = [22];
      platform.devicesDimmableAndColourable = [59];
      // Supported UIIDs that have temperature and/or humidity sensors:
      platform.devicesThermostat = [15];
      // Supported UIIDs that can be set up with a fan and light combination:
      platform.devicesFan = [34]; //
      // Supported UIIDs that are outlets:
      platform.devicesOutlets = [32];
      // Supported UIIDs that are RF Bridges:
      platform.devicesBridge = [28];
      platform.deviceGroups = new Map();
      platform.groupDefaults = {
         "switchUp": 1,
         "switchDown": 2,
         "timeUp": 40,
         "timeDown": 20,
         "timeBottomMarginUp": 0,
         "timeBottomMarginDown": 0,
         "fullOverdrive": 0
      };
      if (api && check) {
         platform.api = api;
         platform.api.on("didFinishLaunching", function () {
            let afterLogin = function () {
               if (platform.debug) platform.log("Authorisation token received [%s].", platform.authenticationToken);
               if (platform.debug) platform.log("User API key received [%s].", platform.apiKey);
               // The cached devices are stored in the "platform.devicesInHB" map with the device ID as the key (with the SW*) part
               platform.log("[%s] eWeLink devices were loaded from the Homebridge cache and will be refreshed.", platform.devicesInHB.size);
               // Let's open a web socket to the eWeLink server to receive real-time updates about external changes to devices.
               // Reason for doing it before the initial HTTP request is to give just a little more time to set up.
               if (platform.debug) platform.log("Opening web socket for real time updates.");
               platform.ws = new WebSocketClient();
               platform.ws.open("wss://" + platform.wsHost + ":8080/api/ws");
               platform.ws.onopen = function (e) {
                  platform.webSocketOpen = true;
                  let payload = {};
                  payload.action = "userOnline";
                  payload.at = platform.authenticationToken;
                  payload.apikey = platform.apiKey;
                  payload.appid = platform.appid;
                  payload.nonce = nonce();
                  payload.ts = Math.floor(new Date() / 1000);
                  payload.userAgent = "app";
                  payload.sequence = Math.floor(new Date());
                  payload.version = 8;
                  if (platform.debugReqRes) platform.log.warn("Sending web socket login request.\n" + JSON.stringify(payload, null, 2));
                  else if (platform.debug) platform.log("Sending web socket login request.");
                  platform.ws.send(JSON.stringify(payload));
               };
               platform.ws.onmessage = function (message) {
                  if (message === "pong") return;
                  if (platform.debugReqRes) platform.log.warn("Web socket message received.\n" + JSON.stringify(JSON.parse(message), null, 2));
                  else if (platform.debug) platform.log("Web socket message received.");
                  let device;
                  try {
                     device = JSON.parse(message);
                  } catch (e) {
                     if (platform.debug) platform.log.warn("An error occured reading the web socket message.");
                     if (platform.debug) platform.log.warn(e);
                     return;
                  }
                  if (device.hasOwnProperty("action")) {
                     let idToCheck = device.deviceid;
                     let accessory;
                     let channelCount;
                     let group;
                     let i;
                     if (device.action === "update" && device.hasOwnProperty("params")) {
                        if (platform.debug) platform.log("External update received via web socket.");
                        if (platform.devicesInHB.has(idToCheck + "SW0") || platform.devicesInHB.has(idToCheck + "SWX")) {
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
                           accessory.getService(Service.AccessoryInformation).setCharacteristic(Characteristic.FirmwareRevision, device.params.fwVersion);
                           //********//
                           // BLINDS //
                           //********//       
                           if (platform.deviceGroups.has(idToCheck + "SWX")) {
                              group = platform.deviceGroups.get(idToCheck + "SWX");
                              if (group.type === "blind" && Array.isArray(device.params.switches)) {
                                 platform.externalBlindUpdate(idToCheck + "SWX", device.params);
                                 return;
                              }
                           }
                           //******//
                           // FANS //
                           //******//                                          
                           else if (platform.devicesFan.includes(accessory.context.eweUIID)) {
                              if (Array.isArray(device.params.switches)) {
                                 platform.externalFanUpdate(idToCheck + "SWX", device.params);
                                 return;
                              }
                           }
                           //*************//
                           // THERMOSTATS //
                           //*************//                                    
                           else if (platform.devicesThermostat.includes(accessory.context.eweUIID)) {
                              if (device.params.hasOwnProperty("currentTemperature") || device.params.hasOwnProperty("currentHumidity") || device.params.hasOwnProperty("switch") || device.params.hasOwnProperty("masterSwitch")) {
                                 platform.externalThermostatUpdate(idToCheck + "SWX", device.params);
                                 return;
                              }
                           }
                           //*********//
                           // OUTLETS //
                           //*********//       
                           else if (platform.devicesOutlets.includes(accessory.context.eweUIID)) {
                              if (device.params.hasOwnProperty("switch")) {
                                 platform.externalOutletUpdate(idToCheck + "SWX", device.params);
                                 return;
                              }
                           }
                           //************************//
                           // LIGHTS [SINGLE SWITCH] //
                           //************************//       
                           else if (platform.devicesSingleSwitch.includes(accessory.context.eweUIID) && platform.devicesSingleSwitchLight.includes(accessory.context.eweModel)) {
                              if (device.params.hasOwnProperty("switch") || device.params.hasOwnProperty("state") || device.params.hasOwnProperty("bright") || device.params.hasOwnProperty("colorR") || device.params.hasOwnProperty("brightness") || device.params.hasOwnProperty("channel0") || device.params.hasOwnProperty("channel2") || device.params.hasOwnProperty("zyx_mode")) {
                                 platform.externalSingleLightUpdate(idToCheck + "SWX", device.params);
                                 return;
                              }
                           }
                           //***********************//
                           // LIGHTS [MULTI SWITCH] //
                           //***********************//
                           else if (platform.devicesMultiSwitch.includes(accessory.context.eweUIID) && platform.devicesMultiSwitchLight.includes(accessory.context.eweModel)) {
                              if (Array.isArray(device.params.switches)) {
                                 platform.externalMultiLightUpdate(idToCheck + "SW0", device.params);
                                 return;
                              }
                           }
                           //***********************//
                           // OTHER SINGLE SWITCHES //
                           //***********************//       
                           else if (platform.devicesSingleSwitch.includes(accessory.context.eweUIID)) {
                              if (device.params.hasOwnProperty("switch")) {
                                 platform.externalSingleSwitchUpdate(idToCheck + "SWX", device.params);
                                 return;
                              }
                           }
                           //**********************//
                           // OTHER MULTI SWITCHES //
                           //**********************//
                           else if (platform.devicesMultiSwitch.includes(accessory.context.eweUIID)) {
                              if (Array.isArray(device.params.switches)) {
                                 platform.externalMultiSwitchUpdate(idToCheck + "SW0", device.params);
                                 return;
                              }
                           }
                           //*********//
                           // BRIDGES //
                           //*********//
                           else if (platform.devicesBridge.includes(accessory.context.eweUIID)) {
                              if (device.params.hasOwnProperty("cmd") && device.params.cmd === "trigger") {
                                 platform.externalBridgeUpdate(idToCheck + "SW0", device.params);
                                 return;
                              }
                           }
                           //**********************//
                           // CATCH OTHER MESSAGES //
                           //**********************//
                           if (device.params.hasOwnProperty("power") || device.params.hasOwnProperty("rssi") || device.params.hasOwnProperty("uiActive")) {
                              return;
                           }
                           
                           platform.log.warn("[%s] could not be refreshed due to a hiccup in the eWeLink message.", device.deviceid);
                        } else {
                           platform.log.warn("[%s] Accessory received via web socket does not exist in Homebridge. If it's a new accessory please try restarting Homebridge so it is added.", device.deviceid);
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
                        if (platform.debug) platform.log.error("Unknown action property or no parameters received via web socket.");
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
               platform.ws.onclose = function (e) {
                  if (platform.debug) platform.log("Web socket was closed [%s].", e);
                  platform.webSocketOpen = false;
                  if (platform.hbInterval) {
                     clearInterval(platform.hbInterval);
                     platform.hbInterval = null;
                  }
               };
               // Get a list of all devices from eWeLink via the HTTPS API, and compare it to the list of Homebridge cached devices (and then vice versa).
               // New devices will be added, existing devices will be refreshed and those in the Homebridge cache but not in the web list will be removed.
               if (platform.debug) platform.log("Requesting a list of devices through the eWeLink HTTPS API.");
               platform.webClient = request.createClient("https://" + platform.apiHost);
               platform.webClient.headers["Authorization"] = "Bearer " + platform.authenticationToken;
               platform.webClient.get("/api/user/device?" + platform.getArguments(platform.apiKey), function (err, res, body) {
                  if (err) {
                     platform.log.error("An error occurred requesting devices through the API.");
                     platform.log.error("[%s].", err);
                     return;
                  } else if (!body) {
                     platform.log.error("An error occurred requesting devices through the API.");
                     platform.log.error("[No data in response].");
                     return;
                  } else if (body.hasOwnProperty("error") && body.error != 0) {
                     let response = JSON.stringify(body);
                     if (platform.debugReqRes) platform.log.warn(response);
                     platform.log.error("An error occurred requesting devices through the API.");
                     if (body.error === "401") {
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
                     platform.api.unregisterPlatformAccessories("homebridge-ewelink-sonoff", "eWeLink", Array.from(platform.devicesInHB.values()));
                     platform.devicesInHB.clear();
                     return;
                  }
                  // The eWeLink devices are stored in the "platform.devicesInEwe" map with the device ID as the key (without the SW*) part.
                  if (platform.debugInitial) platform.log.warn(JSON.stringify(eWeLinkDevices, null, 2));
                  eWeLinkDevices.forEach((device) => {
                     if (!platform.devicesUnsupported.includes(device.uiid)) {
                        platform.devicesInEwe.set(device.deviceid, device);
                     }
                  });
                  // Blind groupings found in the configuration are set in the "platform.deviceGroups" map.
                  if (platform.config["groups"] && Object.keys(platform.config.groups).length > 0) {
                     platform.config.groups.forEach((group) => {
                        if (typeof group.deviceId !== "undefined" && platform.devicesInEwe.has(group.deviceId + "SWX")) {
                           platform.deviceGroups.set(group.deviceId + "SWX", group);
                        }
                     });
                  }
                  platform.log("[%s] primary devices were loaded from your eWeLink account.", primaryDeviceCount);
                  platform.log("[%s] groups were loaded from the Homebridge configuration.", platform.deviceGroups.size);
                  if (platform.debug) platform.log("Checking if devices need to be removed from the Homebridge cache.");
                  // Check that each accessory in the cache appears in the API response [each device in platform.devicesInHB is in [platform.devicesInEwe].
                  if (platform.devicesInHB.size > 0) {
                     platform.devicesInHB.forEach((accessory) => {
                        let hbDeviceId = accessory.context.hbDeviceId;
                        let idToCheck = accessory.context.eweDeviceId;
                        if (!platform.devicesInEwe.has(idToCheck)) {
                           // The cached device wasn't found in the eWeLink response so remove.
                           if (platform.debug) platform.log("[%s] was not present in the API response so removing from Homebridge.", accessory.displayName);
                           platform.removeAccessory(accessory);
                        }
                     });
                  }
                  if (platform.debug) platform.log("Checking if devices need to be added/refreshed in the Homebridge cache.");
                  //  Checking that each device from the API response exists in Homebridge [each device in platform.devicesInEwe is in "platform.devicesInHB"].
                  if (platform.devicesInEwe.size > 0) {
                     platform.devicesInEwe.forEach((device) => {
                        let idToCheck = device.deviceid;
                        let services = {};
                        let accessory;
                        let group;
                        let channelCount;
                        let i;
                        //**************************//
                        // ADD NON EXISTING DEVICES //
                        //**************************//
                        if (!platform.devicesInHB.has(idToCheck + "SWX") && !platform.devicesInHB.has(idToCheck + "SW0")) {
                           //********//
                           // BLINDS //
                           //********//
                           if (platform.deviceGroups.has(idToCheck)) {
                              group = platform.deviceGroups.get(idToCheck);
                              if (group.type === "blind" && Array.isArray(device.params.switches)) {
                                 services.blind = true;
                                 services.group = group;
                                 platform.addAccessory(device, idToCheck + "SWX", services);
                              }
                           }
                           //******//
                           // FANS //
                           //******//                                  
                           else if (platform.devicesFan.includes(device.uiid)) {
                              if (Array.isArray(device.params.switches)) {
                                 services.fan = true;
                                 platform.addAccessory(device, idToCheck + "SWX", services);
                              }
                           }
                           //*************//
                           // THERMOSTATS //
                           //*************//                                                                              
                           else if (platform.devicesThermostat.includes(device.uiid)) {
                              services.thermostatSwitch = true;
                              services.temperature = true;
                              if (device.params.sensorType != "DS18B20") services.humidity = true;
                              platform.addAccessory(device, idToCheck + "SWX", services);
                           }
                           //*********//
                           // OUTLETS //
                           //*********//       
                           else if (platform.devicesOutlets.includes(device.uiid)) {
                              services.outlet = true;
                              platform.addAccessory(device, idToCheck + "SWX", services);
                           }
                           //************************//
                           // LIGHTS [SINGLE SWITCH] //
                           //************************//
                           else if (platform.devicesSingleSwitch.includes(device.uiid) && platform.devicesSingleSwitchLight.includes(device.productModel)) {
                              if (device.params.hasOwnProperty("switch") || device.params.hasOwnProperty("state")) {
                                 services.lightbulb = true;
                                 if (platform.devicesColourable.includes(device.uiid)) services.colourable = true;
                                 if (platform.devicesDimmable.includes(device.uiid)) services.dimmable = true;
                                 if (platform.devicesDimmableAndColourable.includes(device.uiid)) services.dimmableAndColourable = true;
                                 platform.addAccessory(device, idToCheck + "SWX", services);
                              }
                           }
                           //***********************//
                           // LIGHTS [MULTI SWITCH] //
                           //***********************//
                           else if (platform.devicesMultiSwitch.includes(device.uiid) && platform.devicesMultiSwitchLight.includes(device.productModel)) {
                              if (Array.isArray(device.params.switches)) {
                                 services.lightbulb = true;
                                 channelCount = platform.getChannelsByUIID(device.uiid);
                                 for (i = 0; i <= channelCount; i++) {
                                    platform.addAccessory(device, idToCheck + "SW" + i, services);
                                 }
                              }
                           }
                           //***********************//
                           // OTHER SINGLE SWITCHES //
                           //***********************//          
                           else if (platform.devicesSingleSwitch.includes(device.uiid)) {
                              if (device.params.hasOwnProperty("switch")) {
                                 services.switch = true;
                                 platform.addAccessory(device, idToCheck + "SWX", services);
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
                              }
                           }
                           //*********//
                           // BRIDGES //
                           //*********//          
                           else if (platform.devicesBridge.includes(device.uiid)) {
                              if (device.params.hasOwnProperty("rfList")) {
                                 services.bridge = true;
                                 services.bridgeDeviceCount = Object.keys(device.params.rfList).length;
                                 for (i = 0; i <= Object.keys(device.params.rfList).length; i++) {
                                    platform.addAccessory(device, idToCheck + "SW" + i, services);
                                 }
                              }
                           } else {
                              platform.log.warn("[%s] There has been a problem adding this device.", device.name);
                           }
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
                                 return;
                              }
                           }
                           //******//
                           // FANS //
                           //******//                                          
                           else if (platform.devicesFan.includes(accessory.context.eweUIID)) {
                              if (Array.isArray(device.params.switches)) {
                                 platform.externalFanUpdate(idToCheck + "SWX", device.params);
                                 return;
                              }
                           }
                           //*************//
                           // THERMOSTATS //
                           //*************//                                    
                           else if (platform.devicesThermostat.includes(accessory.context.eweUIID)) {
                              if (device.params.hasOwnProperty("currentTemperature") || device.params.hasOwnProperty("currentHumidity") || device.params.hasOwnProperty("switch") || device.params.hasOwnProperty("masterSwitch")) {
                                 platform.externalThermostatUpdate(idToCheck + "SWX", device.params);
                                 return;
                              }
                           }
                           //*********//
                           // OUTLETS //
                           //*********//       
                           else if (platform.devicesOutlets.includes(accessory.context.eweUIID)) {
                              if (device.params.hasOwnProperty("switch")) {
                                 platform.externalOutletUpdate(idToCheck + "SWX", device.params);
                                 return;
                              }
                           }
                           //************************//
                           // LIGHTS [SINGLE SWITCH] //
                           //************************//       
                           else if (platform.devicesSingleSwitch.includes(accessory.context.eweUIID) && platform.devicesSingleSwitchLight.includes(accessory.context.eweModel)) {
                              if (device.params.hasOwnProperty("switch") || device.params.hasOwnProperty("state") || device.params.hasOwnProperty("bright") || device.params.hasOwnProperty("colorR") || device.params.hasOwnProperty("brightness") || device.params.hasOwnProperty("channel0") || device.params.hasOwnProperty("channel2") || device.params.hasOwnProperty("zyx_mode")) {
                                 platform.externalSingleLightUpdate(idToCheck + "SWX", device.params);
                                 return;
                              }
                           }
                           //***********************//
                           // LIGHTS [MULTI SWITCH] //
                           //***********************//
                           else if (platform.devicesMultiSwitch.includes(accessory.context.eweUIID) && platform.devicesMultiSwitchLight.includes(accessory.context.eweModel)) {
                              if (Array.isArray(device.params.switches)) {
                                 platform.externalMultiLightUpdate(idToCheck + "SW0", device.params);
                                 return;
                              }
                           }
                           //***********************//
                           // OTHER SINGLE SWITCHES //
                           //***********************//       
                           else if (platform.devicesSingleSwitch.includes(accessory.context.eweUIID)) {
                              if (device.params.hasOwnProperty("switch")) {
                                 platform.externalSingleSwitchUpdate(idToCheck + "SWX", device.params);
                                 return;
                              }
                           }
                           //**********************//
                           // OTHER MULTI SWITCHES //
                           //**********************//
                           else if (platform.devicesMultiSwitch.includes(accessory.context.eweUIID)) {
                              if (Array.isArray(device.params.switches)) {
                                 platform.externalMultiSwitchUpdate(idToCheck + "SW0", device.params);
                                 return;
                              }
                           }
                           //*********//
                           // BRIDGES //
                           //*********//
                           else if (platform.devicesBridge.includes(accessory.context.eweUIID)) {
                              if (Array.isArray(device.params)) {
                                 platform.externalBridgeUpdate(idToCheck + "SW0", device.params);
                                 return;
                              }
                           }
                        } else {
                           platform.log.warn("[%s] There has been a problem refreshing this device.", device.name);
                        }
                     });
                  }
                  platform.log("Plugin initialisation has been successful.");
               });
            };
            platform.getRegion(platform.config.countryCode, function () {
               platform.login(afterLogin.bind(platform));
            }.bind(platform));
         }.bind(platform));
      }
   }
   addAccessory(device, hbDeviceId, services) {
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
      let channelCount = services.bridge ? services.bridgeDeviceCount : platform.getChannelsByUIID(device.uiid);
      let switchNumber = hbDeviceId.substr(-1);
      let newDeviceName;
      if (switchNumber > channelCount) {
         platform.log.warn("[%s] has not been added as the [%s] only has [%s] switches.", newDeviceName, device.productModel, channelCount);
         return;
      }
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
      accessory.context.isDimmable = false;
      accessory.context.isColourable = false;
      accessory.context.isDimmableAndColourable = false;
      accessory.context.isFan = false;
      accessory.context.isBridge = false;
      accessory.context.isBlind = false;
      accessory.context.isThermostatSwitch = false;
      accessory.context.isOutlet = false;
      accessory.context.channelCount = channelCount;
      accessory.reachable = device.online;
      
      accessory.on("identify", function (paired, callback) {
         platform.log("[%s] identified. Identification on device not supported.", accessory.displayName);
         try {
            callback();
         } catch (e) {}
      });
      if (services.switch) {
         accessory.addService(Service.Switch).getCharacteristic(Characteristic.On)
         .on("set", function (value, callback) {
            platform.internalSwitchUpdate(accessory, value, callback);
         });
      }
      if (services.outlet) {
         accessory.context.isOutlet = true;
         accessory.addService(Service.Outlet).getCharacteristic(Characteristic.On)
         .on("set", function (value, callback) {
            platform.internalOutletUpdate(accessory, value, callback);
         });
         accessory.getService(Service.Outlet).setCharacteristic(Characteristic.OutletInUse, true);
      }
      if (services.lightbulb) {
         accessory.addService(Service.Lightbulb);
         if (services.dimmable) {
            accessory.context.isDimmable = true;
            accessory.getService(Service.Lightbulb).getCharacteristic(Characteristic.On)
            .on("set", function (value, callback) {
               platform.internalDimmerUpdate(accessory, value, callback);
            });
            accessory.getService(Service.Lightbulb).getCharacteristic(Characteristic.Brightness)
            .on("set", function (value, callback) {
               platform.internalDimmerUpdate(accessory, value, callback);
            });
         } else if (services.colourable) {
            accessory.context.isColourable = true;
            accessory.getService(Service.Lightbulb).getCharacteristic(Characteristic.On)
            .on("set", function (value, callback) {
               platform.internalColourUpdate(accessory, value, callback);
            });
            accessory.getService(Service.Lightbulb).getCharacteristic(Characteristic.Hue)
            .on("set", function (value, callback) {
               platform.internalColourUpdate(accessory, convert.hsv.rgb(value, 100, 100), callback);
            });
            accessory.getService(Service.Lightbulb).updateCharacteristic(Characteristic.Saturation, 100);
            accessory.getService(Service.Lightbulb).updateCharacteristic(Characteristic.Brightness, 100);
            
         } else if (services.dimmableAndColourable) {
            accessory.context.isDimmableAndColourable = true;
            accessory.getService(Service.Lightbulb).getCharacteristic(Characteristic.On)
            .on("set", function (value, callback) {
               platform.internalDimmerAndColourUpdate(accessory, 'on', value, callback);
            });
            accessory.getService(Service.Lightbulb).getCharacteristic(Characteristic.Brightness)
            .on("set", function (value, callback) {
               platform.internalDimmerAndColourUpdate(accessory, 'brightness', value, callback);
            });
            accessory.getService(Service.Lightbulb).getCharacteristic(Characteristic.Hue)
            .on("set", function (value, callback) {
               platform.internalDimmerAndColourUpdate(accessory, 'hue', value, callback);
            });
            accessory.getService(Service.Lightbulb).updateCharacteristic(Characteristic.Saturation, 100);
         } else {
            accessory.getService(Service.Lightbulb).getCharacteristic(Characteristic.On)
            .on("set", function (value, callback) {
               platform.internalLightbulbUpdate(accessory, value, callback);
            });
         }
      }
      if (services.fan) {
         accessory.context.isFan = true;
         accessory.addService(Service.Fanv2).getCharacteristic(Characteristic.On)
         .on("set", function (value, callback) {
            platform.internalFanUpdate(accessory, "power", value, callback);
         })
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
      }
      
      if (services.thermostatSwitch) {
         accessory.context.isThermostatSwitch = true;
         accessory.addService(Service.Switch).getCharacteristic(Characteristic.On)
         .on("set", function (value, callback) {
            platform.internalThermostatUpdate(accessory, value, callback);
         });
      }
      if (services.temperature) {
         accessory.addService(Service.TemperatureSensor);
      }
      if (services.humidity) {
         accessory.addService(Service.HumiditySensor);
      }
      if (services.bridge) {
         accessory.context.isBridge = true;
         accessory.addService(Service.MotionSensor).setCharacteristic(Characteristic.MotionDetected, false);
      }
      if (services.blind) {
         accessory.context.isBlind = true;
         accessory.addService(Service.WindowCovering).getCharacteristic(Characteristic.TargetPosition)
         .on("set", function (value, callback) {
            platform.setBlindTargetPosition(accessory, value, callback);
         });
         let payload = {};
         payload.action = "update";
         payload.userAgent = "app";
         payload.params = {
            "lock": 0,
            "zyx_clear_timers": false,
            "configure": [{
               "startup": "off",
               "outlet": 0
            }, {
               "startup": "off",
               "outlet": 1
            }, {
               "startup": "off",
               "outlet": 2
            }, {
               "startup": "off",
               "outlet": 3
            }],
            "pulses": [{
               "pulse": "off",
               "width": 1000,
               "outlet": 0
            }, {
               "pulse": "off",
               "width": 1000,
               "outlet": 1
            }, {
               "pulse": "off",
               "width": 1000,
               "outlet": 2
            }, {
               "pulse": "off",
               "width": 1000,
               "outlet": 3
            }],
            "switches": [{
               "switch": "off",
               "outlet": 0
            }, {
               "switch": "off",
               "outlet": 1
            }, {
               "switch": "off",
               "outlet": 2
            }, {
               "switch": "off",
               "outlet": 3
            }]
         };
         payload.apikey = accessory.context.eweApiKey;
         payload.deviceid = accessory.context.eweDeviceId;
         payload.sequence = Math.floor(new Date());
         if (platform.debugReqRes) platform.log.warn(payload);
         platform.sendWSMessage(JSON.stringify(payload), function () {
            return;
         });
         if (platform.debug) platform.log("[%s] initialising switches for correct start up.", accessory.displayName);
         accessory.context.lastPosition = accessory.context.lastPosition >= 0 ? accessory.context.lastPosition : 0;
         accessory.context.cTargetPos = accessory.context.lastPosition;
         accessory.context.cMoveState = 2;
         let group = platform.deviceGroups.get(accessory.context.hbDeviceId);
         if (group) {
            accessory.context.switchUp = (group.switchUp || platform.groupDefaults["switchUp"]) - 1;
            accessory.context.switchDown = (group.switchDown || platform.groupDefaults["switchDown"]) - 1;
            accessory.context.durationUp = group.timeUp || platform.groupDefaults["timeUp"];
            accessory.context.durationDown = group.timeDown || platform.groupDefaults["timeDown"];
            accessory.context.durationBMU = group.timeBottomMarginUp || platform.groupDefaults["timeBottomMarginUp"];
            accessory.context.durationBMD = group.timeBottomMarginDown || platform.groupDefaults["timeBottomMarginDown"];
            accessory.context.fullOverdrive = platform.groupDefaults["fullOverdrive"];
            accessory.context.percentDurationDown = accessory.context.durationDown * 10;
            accessory.context.percentDurationUp = accessory.context.durationUp * 10;
         }
      }
      try {
         accessory.getService(Service.AccessoryInformation).setCharacteristic(Characteristic.SerialNumber, hbDeviceId);
         accessory.getService(Service.AccessoryInformation).setCharacteristic(Characteristic.Manufacturer, device.brandName);
         accessory.getService(Service.AccessoryInformation).setCharacteristic(Characteristic.Model, device.productModel + " (" + device.extra.extra.model + ")");
         accessory.getService(Service.AccessoryInformation).setCharacteristic(Characteristic.Identify, false);
         accessory.getService(Service.AccessoryInformation).setCharacteristic(Characteristic.FirmwareRevision, device.params.fwVersion);
      } catch (e) {
         platform.log.error("[%s] has not been added [%s].", accessory.displayName, e);
      }
      platform.devicesInHB.set(hbDeviceId, accessory);
      platform.api.registerPlatformAccessories("homebridge-ewelink-sonoff", "eWeLink", [accessory]);
      if (platform.debug) platform.log("[%s] has been added to Homebridge.", newDeviceName);
   }
   
   configureAccessory (accessory) {
      let platform = this;
      if (!platform.log) {
         return;
      }
      if (accessory.getService(Service.Switch) && !accessory.context.isThermostatSwitch) {
         accessory.getService(Service.Switch).getCharacteristic(Characteristic.On)
         .on("set", function (value, callback) {
            platform.internalSwitchUpdate(accessory, value, callback);
         });
      }
      if (accessory.getService(Service.Outlet)) {
         accessory.getService(Service.Outlet).getCharacteristic(Characteristic.On)
         .on("set", function (value, callback) {
            platform.internalOutletUpdate(accessory, value, callback);
         });
         accessory.getService(Service.Outlet).setCharacteristic(Characteristic.OutletInUse, true);
      }
      if (accessory.getService(Service.Lightbulb) && !accessory.context.isFan) {
         if (accessory.context.isDimmable) {
            accessory.getService(Service.Lightbulb).getCharacteristic(Characteristic.On)
            .on("set", function (value, callback) {
               platform.internalDimmerUpdate(accessory, value, callback);
            });
            accessory.getService(Service.Lightbulb).getCharacteristic(Characteristic.Brightness)
            .on("set", function (value, callback) {
               platform.internalDimmerUpdate(accessory, value, callback);
            });
         } else if (accessory.context.isColourable) {
            accessory.getService(Service.Lightbulb).getCharacteristic(Characteristic.On)
            .on("set", function (value, callback) {
               platform.internalColourUpdate(accessory, value, callback);
            });
            accessory.getService(Service.Lightbulb).getCharacteristic(Characteristic.Hue)
            .on("set", function (value, callback) {
               platform.internalColourUpdate(accessory, convert.hsv.rgb(value, 100, 100), callback);
            });
            accessory.getService(Service.Lightbulb).updateCharacteristic(Characteristic.Saturation, 100);
            accessory.getService(Service.Lightbulb).updateCharacteristic(Characteristic.Brightness, 100);
         } else if (accessory.context.isDimmableAndColourable) {
            accessory.getService(Service.Lightbulb).getCharacteristic(Characteristic.On)
            .on("set", function (value, callback) {
               platform.internalDimmerAndColourUpdate(accessory, 'on', value, callback);
            });
            accessory.getService(Service.Lightbulb).getCharacteristic(Characteristic.Brightness)
            .on("set", function (value, callback) {
               platform.internalDimmerAndColourUpdate(accessory, 'brightness', value, callback);
            });
            accessory.getService(Service.Lightbulb).getCharacteristic(Characteristic.Hue)
            .on("set", function (value, callback) {
               platform.internalDimmerAndColourUpdate(accessory, 'hue', value, callback);
            });
            accessory.getService(Service.Lightbulb).updateCharacteristic(Characteristic.Saturation, 100);
         } else {
            accessory.getService(Service.Lightbulb).getCharacteristic(Characteristic.On)
            .on("set", function (value, callback) {
               platform.internalLightbulbUpdate(accessory, value, callback);
            });
         }
      }
      if (accessory.getService(Service.Fanv2)) {
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
      }
      if (accessory.getService(Service.Lightbulb) && accessory.context.isFan) {
         accessory.getService(Service.Lightbulb).getCharacteristic(Characteristic.On)
         .on("set", function (value, callback) {
            platform.internalFanUpdate(accessory, "light", value, callback);
         });
      }
      if (accessory.getService(Service.MotionSensor) && accessory.context.isBridge) {
         accessory.getService(Service.MotionSensor).setCharacteristic(Characteristic.MotionDetected, false);
      }
      if (accessory.context.isThermostatSwitch) {
         accessory.getService(Service.Switch).getCharacteristic(Characteristic.On)
         .on("set", function (value, callback) {
            platform.internalThermostatUpdate(accessory, value, callback);
         });
      }
      if (accessory.getService(Service.WindowCovering)) {
         accessory.getService(Service.WindowCovering).getCharacteristic(Characteristic.TargetPosition)
         .on("set", function (value, callback) {
            platform.setBlindTargetPosition(accessory, value, callback);
         });
         let payload = {};
         payload.action = "update";
         payload.userAgent = "app";
         payload.params = {
            "lock": 0,
            "zyx_clear_timers": false,
            "configure": [{
               "startup": "off",
               "outlet": 0
            }, {
               "startup": "off",
               "outlet": 1
            }, {
               "startup": "off",
               "outlet": 2
            }, {
               "startup": "off",
               "outlet": 3
            }],
            "pulses": [{
               "pulse": "off",
               "width": 1000,
               "outlet": 0
            }, {
               "pulse": "off",
               "width": 1000,
               "outlet": 1
            }, {
               "pulse": "off",
               "width": 1000,
               "outlet": 2
            }, {
               "pulse": "off",
               "width": 1000,
               "outlet": 3
            }],
            "switches": [{
               "switch": "off",
               "outlet": 0
            }, {
               "switch": "off",
               "outlet": 1
            }, {
               "switch": "off",
               "outlet": 2
            }, {
               "switch": "off",
               "outlet": 3
            }]
         };
         payload.apikey = accessory.context.eweApiKey;
         payload.deviceid = accessory.context.eweDeviceId;
         payload.sequence = Math.floor(new Date());
         if (platform.debugReqRes) platform.log.warn(payload);
         platform.sendWSMessage(JSON.stringify(payload), function () {
            return;
         });
         if (platform.debug) platform.log("[%s] initialising switches for correct start up.", accessory.displayName);
         accessory.context.lastPosition = accessory.context.lastPosition >= 0 ? accessory.context.lastPosition : 0;
         accessory.context.cTargetPos = accessory.context.lastPosition;
         accessory.context.cMoveState = 2;
         let group = platform.deviceGroups.get(accessory.context.hbDeviceId);
         if (group) {
            accessory.context.switchUp = (group.switchUp || platform.groupDefaults["switchUp"]) - 1;
            accessory.context.switchDown = (group.switchDown || platform.groupDefaults["switchDown"]) - 1;
            accessory.context.durationUp = group.timeUp || platform.groupDefaults["timeUp"];
            accessory.context.durationDown = group.timeDown || platform.groupDefaults["timeDown"];
            accessory.context.durationBMU = group.timeBottomMarginUp || platform.groupDefaults["timeBottomMarginUp"];
            accessory.context.durationBMD = group.timeBottomMarginDown || platform.groupDefaults["timeBottomMarginDown"];
            accessory.context.fullOverdrive = platform.groupDefaults["fullOverdrive"];
            accessory.context.percentDurationDown = accessory.context.durationDown * 10;
            accessory.context.percentDurationUp = accessory.context.durationUp * 10;
         }
      }
      accessory.reachable = true;
      platform.devicesInHB.set(accessory.context.hbDeviceId, accessory);
   }
   
   removeAccessory (accessory) {
      let platform = this;
      if (!platform.log) {
         return;
      }
      platform.devicesInHB.delete(accessory.context.hbDeviceId);
      platform.api.unregisterPlatformAccessories("homebridge-ewelink-sonoff", "eWeLink", [accessory]);
      if (platform.debug) platform.log("[%s] has been removed from Homebridge.", accessory.displayName);
   }
   
   internalSwitchUpdate (accessory, isOn, callback) {
      let platform = this;
      if (!platform.log) {
         return;
      }
      let targetState = isOn ? "on" : "off";
      let otherAccessory;
      let i;
      let payload = {};
      payload.action = "update";
      payload.userAgent = "app";
      payload.apikey = accessory.context.eweApiKey;
      payload.deviceid = accessory.context.eweDeviceId;
      payload.sequence = Math.floor(new Date());
      payload.params = {};
      switch (accessory.context.switchNumber) {
         case "X":
         if (platform.debug) platform.log("[%s] requesting to turn [%s].", accessory.displayName, targetState);
         payload.params.switch = targetState;
         accessory.getService(Service.Switch).updateCharacteristic(Characteristic.On, isOn);
         break;
         case "0":
         if (platform.debug) platform.log("[%s] requesting to turn group [%s].", accessory.displayName, targetState);
         payload.params.switches = platform.devicesInEwe.get(accessory.context.eweDeviceId).params.switches;
         payload.params.switches[0].switch = targetState;
         payload.params.switches[1].switch = targetState;
         payload.params.switches[2].switch = targetState;
         payload.params.switches[3].switch = targetState;
         accessory.getService(Service.Switch).updateCharacteristic(Characteristic.On, isOn);
         for (i = 1; i <= 4; i++) {
            if (platform.devicesInHB.has(accessory.context.eweDeviceId + "SW" + i)) {
               otherAccessory = platform.devicesInHB.get(accessory.context.eweDeviceId + "SW" + i);
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
         otherAccessory.getService(Service.Switch).updateCharacteristic(Characteristic.On, masterState === "on" ? true : false);
         break;
      }
      platform.sendWSMessage(JSON.stringify(payload), callback);
   }
   
   internalOutletUpdate (accessory, isOn, callback) {
      let platform = this;
      if (!platform.log) {
         return;
      }
      let targetState = isOn ? "on" : "off";
      let payload = {};
      payload.action = "update";
      payload.userAgent = "app";
      payload.apikey = accessory.context.eweApiKey;
      payload.deviceid = accessory.context.eweDeviceId;
      payload.sequence = Math.floor(new Date());
      payload.params = {};
      if (platform.debug) platform.log("[%s] requesting to turn [%s].", accessory.displayName, targetState);
      payload.params.switch = targetState;
      accessory.getService(Service.Outlet).updateCharacteristic(Characteristic.On, isOn);
      platform.sendWSMessage(JSON.stringify(payload), callback);
   }
   
   internalLightbulbUpdate (accessory, isOn, callback) {
      let platform = this;
      if (!platform.log) {
         return;
      }
      let targetState = isOn ? "on" : "off";
      let otherAccessory;
      let i;
      let payload = {};
      payload.action = "update";
      payload.userAgent = "app";
      payload.apikey = accessory.context.eweApiKey;
      payload.deviceid = accessory.context.eweDeviceId;
      payload.sequence = Math.floor(new Date());
      payload.params = {};
      switch (accessory.context.switchNumber) {
         case "X":
         if (platform.debug) platform.log("[%s] requesting to turn [%s].", accessory.displayName, targetState);
         payload.params.state = targetState;
         payload.params.switch = targetState;
         accessory.getService(Service.Lightbulb).updateCharacteristic(Characteristic.On, isOn);
         break;
         case "0":
         if (platform.debug) platform.log("[%s] requesting to turn group [%s].", accessory.displayName, targetState);
         payload.params.switches = platform.devicesInEwe.get(accessory.context.eweDeviceId).params.switches;
         payload.params.switches[0].switch = targetState;
         payload.params.switches[1].switch = targetState;
         payload.params.switches[2].switch = targetState;
         payload.params.switches[3].switch = targetState;
         accessory.getService(Service.Lightbulb).updateCharacteristic(Characteristic.On, isOn);
         for (i = 1; i <= 4; i++) {
            if (platform.devicesInHB.has(accessory.context.eweDeviceId + "SW" + i)) {
               otherAccessory = platform.devicesInHB.get(accessory.context.eweDeviceId + "SW" + i);
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
         otherAccessory.getService(Service.Lightbulb).updateCharacteristic(Characteristic.On, masterState === "on" ? true : false);
         break;
      }
      platform.sendWSMessage(JSON.stringify(payload), callback);
   }
   
   internalDimmerUpdate (accessory, targetBrightness, callback) {
      let platform = this;
      if (!platform.log) {
         return;
      }
      let payload = {};
      payload.action = "update";
      payload.userAgent = "app";
      payload.apikey = accessory.context.eweApiKey;
      payload.deviceid = accessory.context.eweDeviceId;
      payload.sequence = Math.floor(new Date());
      payload.params = {};
      if (Number.isInteger(targetBrightness)) {
         accessory.getService(Service.Lightbulb).updateCharacteristic(Characteristic.On, targetBrightness != 0);
         if (targetBrightness === 0) {
            if (platform.debug) platform.log("[%s] requesting to turn off.", accessory.displayName);
            payload.params.switch = "off";
            payload.params.state = "off";
         } else {
            accessory.getService(Service.Lightbulb).updateCharacteristic(Characteristic.Brightness, targetBrightness);
            if (platform.debug) platform.log("[%s] requesting to turn brightness to [%s%].", accessory.displayName, targetBrightness);
            payload.params.switch = "on";
            payload.params.state = "on";
            payload.params.brightness = Math.max(targetBrightness, 1);
            payload.params.bright = Math.max(targetBrightness, 1);
         }
      } else {
         if (targetBrightness) {
            if (platform.debug) platform.log("[%s] requesting to turn on.", accessory.displayName);
            payload.params.switch = "on";
            payload.params.state = "on";
            accessory.getService(Service.Lightbulb).updateCharacteristic(Characteristic.On, true);
         } else {
            if (platform.debug) platform.log("[%s] requesting to turn off.", accessory.displayName);
            payload.params.switch = "off";
            payload.params.state = "off";
            accessory.getService(Service.Lightbulb).updateCharacteristic(Characteristic.On, false);
         }
      }
      platform.sendWSMessage(JSON.stringify(payload), callback);
   }
   
   internalColourUpdate (accessory, newRGB, callback) {
      let platform = this;
      if (!platform.log) {
         return;
      }
      let newHSV;
      let payload = {};
      payload.action = "update";
      payload.userAgent = "app";
      payload.apikey = accessory.context.eweApiKey;
      payload.deviceid = accessory.context.eweDeviceId;
      payload.sequence = Math.floor(new Date());
      payload.params = {};
      
      if (Array.isArray(newRGB)) {
         newHSV = convert.rgb.hsv(newRGB);
         
         if (accessory.context.eweUIID === 59) // L1
         {
            payload.params.colorR = newRGB[0];
            payload.params.colorG = newRGB[1];
            payload.params.colorB = newRGB[2];
         } else { // B1
            payload.params.zyx_mode = 2;
            payload.params.channel2 = newRGB[0].toString();
            payload.params.channel3 = newRGB[1].toString();
            payload.params.channel4 = newRGB[2].toString();
         }
         accessory.getService(Service.Lightbulb).updateCharacteristic(Characteristic.Hue, newHSV[0]);
         accessory.getService(Service.Lightbulb).updateCharacteristic(Characteristic.Saturation, 100);
         accessory.getService(Service.Lightbulb).updateCharacteristic(Characteristic.Brightness, 100);
         if (platform.debug) platform.log("[%s] requesting to change colour to hue [%s].", accessory.displayName, newHSV[0]);
      } else {
         payload.params.state = newRGB ? "on" : "off";
         payload.params.switch = newRGB ? "on" : "off";
         if (platform.debug) platform.log("[%s] requesting to change turn [%s].", accessory.displayName, payload.params.state);
      }
      platform.sendWSMessage(JSON.stringify(payload), callback);
   }
   
   internalDimmerAndColourUpdate (accessory, type, value, callback) {
      let platform = this;
      if (!platform.log) {
         return;
      }
      
      let payload = {};
      payload.action = "update";
      payload.userAgent = "app";
      payload.apikey = accessory.context.eweApiKey;
      payload.deviceid = accessory.context.eweDeviceId;
      payload.sequence = Math.floor(new Date());
      payload.params = {};
      
      switch (type) {
         case "on":
         if (value) {
            if (platform.debug) platform.log("[%s] requesting to turn on.", accessory.displayName);
            payload.params.switch = "on";
            payload.params.state = "on";
            accessory.getService(Service.Lightbulb).updateCharacteristic(Characteristic.On, true);
         } else {
            if (platform.debug) platform.log("[%s] requesting to turn off.", accessory.displayName);
            payload.params.switch = "off";
            payload.params.state = "off";
            accessory.getService(Service.Lightbulb).updateCharacteristic(Characteristic.On, false);
         }
         break;
         case "brightness":
         if (Number.isInteger(targetBrightness)) {
            accessory.getService(Service.Lightbulb).updateCharacteristic(Characteristic.On, targetBrightness != 0);
            if (targetBrightness === 0) {
               if (platform.debug) platform.log("[%s] requesting to turn off.", accessory.displayName);
               payload.params.switch = "off";
               payload.params.state = "off";
            } else {
               accessory.getService(Service.Lightbulb).updateCharacteristic(Characteristic.Brightness, targetBrightness);
               if (platform.debug) platform.log("[%s] requesting to turn brightness to [%s%].", accessory.displayName, targetBrightness);
               payload.params.switch = "on";
               payload.params.state = "on";
               payload.params.brightness = Math.max(targetBrightness, 1);
               payload.params.bright = Math.max(targetBrightness, 1);
            }
         } else {
            if (targetBrightness) {
               if (platform.debug) platform.log("[%s] requesting to turn on.", accessory.displayName);
               payload.params.switch = "on";
               payload.params.state = "on";
               accessory.getService(Service.Lightbulb).updateCharacteristic(Characteristic.On, true);
            } else {
               if (platform.debug) platform.log("[%s] requesting to turn off.", accessory.displayName);
               payload.params.switch = "off";
               payload.params.state = "off";
               accessory.getService(Service.Lightbulb).updateCharacteristic(Characteristic.On, false);
            }
         }
         break;
         
         case "hue":
         let newRGB = convert.hsv.rgb(value, 100, 100);
         let newHSV = convert.rgb.hsv(newRGB);
         accessory.getService(Service.Lightbulb).updateCharacteristic(Characteristic.Hue, newHSV[0]);
         
         if (accessory.context.eweUIID === 59) { // L1
            payload.params.colorR = newRGB[0];
            payload.params.colorG = newRGB[1];
            payload.params.colorB = newRGB[2];
         } else { // B1
            payload.params.zyx_mode = 2;
            payload.params.channel2 = newRGB[0];
            payload.params.channel3 = newRGB[1];
            payload.params.channel4 = newRGB[2];
         }
         if (platform.debug) platform.log("[%s] requesting to change colour to hue [%s].", accessory.displayName, newHSV[0]);
         break;
      }
      platform.sendWSMessage(JSON.stringify(payload), callback);
   }
   
   internalFanUpdate (accessory, type, targetState, callback) {
      let platform = this;
      if (!platform.log) {
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
      if (platform.debug) platform.log("[%s] requesting to change fan %s.", accessory.displayName, type);
      let payload = {};
      payload.params = {};
      payload.params.switches = platform.devicesInEwe.get(accessory.context.eweDeviceId).params.switches;
      payload.params.switches[0].switch = newLight ? "on" : "off";
      payload.params.switches[1].switch = newSpeed >= 33 ? "on" : "off";
      payload.params.switches[2].switch = newSpeed >= 66 && newSpeed < 99 ? "on" : "off";
      payload.params.switches[3].switch = newSpeed >= 99 ? "on" : "off";
      payload.action = "update";
      payload.userAgent = "app";
      payload.apikey = accessory.context.eweApiKey;
      payload.deviceid = accessory.context.eweDeviceId;
      payload.sequence = Math.floor(new Date());
      platform.sendWSMessage(JSON.stringify(payload), callback);
   }
   
   internalThermostatUpdate (accessory, targetState, callback) {
      let platform = this;
      if (!platform.log) {
         return;
      }
      if (platform.debug) platform.log("[%s] requesting to turn switch [%s].", accessory.displayName, targetState ? "on" : "off");
      accessory.getService(Service.Switch).updateCharacteristic(Characteristic.On, targetState);
      let payload = {};
      payload.params = {};
      payload.action = "update";
      payload.userAgent = "app";
      payload.apikey = accessory.context.eweApiKey;
      payload.deviceid = accessory.context.eweDeviceId;
      payload.sequence = Math.floor(new Date());
      payload.params.switch = targetState ? "on" : "off";
      payload.params.mainSwitch = targetState ? "on" : "off";
      platform.sendWSMessage(JSON.stringify(payload), callback);
   }
   
   setBlindTargetPosition (accessory, pos, callback) {
      let platform = this;
      if (!platform.log) {
         return;
      }
      platform.log("Setting [%s] new target position from [%s] to [%s].", accessory.displayName, accessory.context.cTargetPos, pos, );
      let timestamp = Date.now();
      if (accessory.context.cMoveState != 2) {
         var diffPosition = Math.abs(pos - accessory.context.cTargetPos);
         var actualPosition;
         var diffTime;
         var diff;
         
         if (diffPosition === 0) {
            actualPosition = pos;
            diffTime = 0;
            diff = 0;
         } else {
            if (accessory.context.cMoveState === 1) {
               diffPosition = accessory.context.cTargetPos - pos;
               diffTime = Math.round(accessory.context.percentDurationDown * diffPosition);
            } else {
               diffPosition = pos - accessory.context.cTargetPos;
               diffTime = Math.round(accessory.context.percentDurationUp * diffPosition);
            }
            diff = (accessory.context.targetTimestamp - timestamp) + diffTime;
            
            let timestamp = Date.now();
            if (accessory.context.cMoveState === 1) {
               actualPosition = Math.round(accessory.context.lastPosition - ((timestamp - accessory.context.startTimestamp) / accessory.context.percentDurationDown));
            } else if (accessory.context.cMoveState === 0) {
               actualPosition = Math.round(accessory.context.lastPosition + ((timestamp - accessory.context.startTimestamp) / accessory.context.percentDurationUp));
            } else {
               actualPosition = accessory.context.lastPosition;
            }
            
            // platform.log("diffPosition:", diffPosition);
            // platform.log("diffTime:", diffTime);
            // platform.log("actualPosition:", actualPosition);
            // platform.log("diff:", diff);
            
            if (diff > 0) {
               accessory.context.targetTimestamp += diffTime;
               // if (pos==0 || pos==100) accessory.context.targetTimestamp += accessory.context.fullOverdrive;
               accessory.context.cTargetPos = pos;
               platform.log("[%s] Blinds are moving. Current position: %s, new targuet: %s, adjusting target milliseconds: %s", accessory.displayName, actualPosition, pos, diffTime);
               callback();
               return false;
            }
            if (diff < 0) {
               platform.log("[%s] ==> Revert Blinds moving. Current pos: %s, new target: %s, new duration: %s", accessory.displayName, actualPosition, pos, Math.abs(diff));
               accessory.context.startTimestamp = timestamp;
               accessory.context.targetTimestamp = timestamp + Math.abs(diff);
               // if (pos==0 || pos==100) accessory.context.targetTimestamp += accessory.context.fullOverdrive;
               accessory.context.lastPosition = actualPosition;
               accessory.context.cTargetPos = pos;
               accessory.context.cMoveState = accessory.context.cMoveState === 0 ? 1 : 0;
               
               let payload = platform.prepareBlindPayload(accessory);
               let string = JSON.stringify(payload);
               if (platform.debugReqRes) platform.log.warn(payload);
               
               if (platform.webSocketOpen) {
                  platform.sendWSMessage(string, function () {
                     return;
                  });
                  platform.log("[%s] Request sent for %s", accessory.displayName, accessory.context.cMoveState === 1 ? "moving up" : "moving down");
                  let service = accessory.getService(Service.WindowCovering);
                  service.getCharacteristic(Characteristic.CurrentPosition)
                  .updateValue(accessory.context.lastPosition);
                  service.getCharacteristic(Characteristic.TargetPosition)
                  .updateValue(accessory.context.cTargetPos);
                  service.getCharacteristic(Characteristic.PositionState)
                  .updateValue(accessory.context.cMoveState);
               } else {
                  platform.log("Socket was closed. It will reconnect automatically; please retry your command");
                  callback("Socket was closed. It will reconnect automatically; please retry your command");
                  return false;
               }
            }
            callback();
            return false;
         }
         callback();
         return false;
      }
      
      if (accessory.context.lastPosition === pos) {
         platform.log("[%s] Current position already matches target position. There is nothing to do.", accessory.displayName);
         callback();
         return true;
      }
      
      accessory.context.cTargetPos = pos;
      moveUp = (pos > accessory.context.lastPosition);
      
      var withoutmarginetimeUP;
      var withoutmarginetimeDOWN;
      var duration;
      withoutmarginetimeUP = accessory.context.durationUp - accessory.context.durationBMU;
      withoutmarginetimeDOWN = accessory.context.durationDown - accessory.context.durationBMD;
      
      if (moveUp) {
         if (accessory.context.lastPosition === 0) {
            duration = ((pos - accessory.context.lastPosition) / 100 * withoutmarginetimeUP) + accessory.context.durationBMU;
         } else {
            duration = (pos - accessory.context.lastPosition) / 100 * withoutmarginetimeUP;
         }
      } else {
         if (pos === 0) {
            duration = ((accessory.context.lastPosition - pos) / 100 * withoutmarginetimeDOWN) + accessory.context.durationBMD;
         } else {
            duration = (accessory.context.lastPosition - pos) / 100 * withoutmarginetimeDOWN;
         }
      }
      if (pos === 0 || pos === 100) duration += accessory.context.fullOverdrive;
      if (pos === 0 || pos === 100) platform.log("[%s] add overdive: %s", accessory.displayName, accessory.context.fullOverdrive);
      
      duration = Math.round(duration * 100) / 100;
      
      platform.log("[%s] %s, Duration: %s", accessory.displayName, moveUp ? "Moving up" : "Moving down", duration);
      
      accessory.context.startTimestamp = timestamp;
      accessory.context.targetTimestamp = timestamp + (duration * 1000);
      // if (pos==0 || pos==100) accessory.context.targetTimestamp += accessory.context.fullOverdrive;
      accessory.context.cMoveState = (moveUp ? 0 : 1);
      accessory.getService(Service.WindowCovering)
      .setCharacteristic(Characteristic.PositionState, (moveUp ? 0 : 1));
      
      let payload = platform.prepareBlindPayload(accessory);
      let string = JSON.stringify(payload);
      if (platform.debugReqRes) platform.log.warn(payload);
      
      if (platform.webSocketOpen) {
         
         setTimeout(function () {
            platform.sendWSMessage(string, function () {
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
         platform.log("Socket was closed. It will reconnect automatically; please retry your command");
         callback("Socket was closed. It will reconnect automatically; please retry your command");
         return false;
      }
   }
   
   prepareBlindFinalState (accessory) {
      
      let platform = this;
      
      if (!platform.log) {
         return;
      }
      accessory.context.cMoveState = 2;
      let payload = platform.prepareBlindPayload(accessory);
      let string = JSON.stringify(payload);
      if (platform.debugReqRes) platform.log.warn(payload);
      
      if (platform.webSocketOpen) {
         
         setTimeout(function () {
            platform.sendWSMessage(string, function () {
               return;
            });
            platform.log("[%s] Request sent to stop moving", accessory.displayName);
            accessory.context.cMoveState = 2;
            
            let cTargetPos = accessory.context.cTargetPos;
            accessory.context.lastPosition = cTargetPos;
            let service = accessory.getService(Service.WindowCovering);
            // Using updateValue to avoid loop
            service.getCharacteristic(Characteristic.CurrentPosition)
            .updateValue(cTargetPos);
            service.getCharacteristic(Characteristic.TargetPosition)
            .updateValue(cTargetPos);
            service.setCharacteristic(Characteristic.PositionState, Characteristic.PositionState.STOPPED);
            
            platform.log("[%s] Successfully moved to target position: %s", accessory.displayName, cTargetPos);
            return true;
            // TODO Here we need to wait for the response to the socket
         }, 1);
         
      } else {
         platform.log("Socket was closed. It will reconnect automatically; please retry your command");
         return false;
      }
   }
   
   prepareBlindPayload (accessory) {
      
      let platform = this;
      if (!platform.log) {
         return;
      }
      let payload = {};
      payload.action = "update";
      payload.userAgent = "app";
      payload.params = {};
      let deviceFromApi = platform.devicesInEwe.get(accessory.context.hbDeviceId);
      
      payload.params.switches = deviceFromApi.params.switches;
      
      // [0,0] = 0 => 2 Stopped
      // [0,1] = 1 => 1 Moving down
      // [1,0] = 2 => 0 Moving up
      // [1,1] = 3 => should not happen...
      
      var switch0 = "off";
      var switch1 = "off";
      
      let state = accessory.context.cMoveState;
      
      switch (state) {
         case 2:
         switch0 = "off";
         switch1 = "off";
         break;
         case 1:
         switch0 = "off";
         switch1 = "on";
         break;
         case 0:
         switch0 = "on";
         switch1 = "off";
         break;
         default:
         platform.log("[%s] PositionState type error !", accessory.displayName);
         break;
      }
      
      payload.params.switches[accessory.context.switchUp].switch = switch0;
      payload.params.switches[accessory.context.switchDown].switch = switch1;
      payload.apikey = accessory.context.eweApiKey;
      payload.deviceid = accessory.context.hbDeviceId;
      payload.sequence = Math.floor(new Date());
      // platform.log("Payload genretad:", JSON.stringify(payload))
      return payload;
   }
   
   externalBlindUpdate(hbDeviceId, params) {
      let platform = this;
      if (!platform.log) {
         return;
      }
      let accessory = platform.devicesInHB.get(hbDeviceId);
      let switchUp = params.switches[accessory.context.switchUp].switch === "on" ? 1 : 0;
      let switchDown = params.switches[accessory.context.switchDown].switch === "on" ? 1 : 0;
      
      const MAPPING = {
         0: 2, // [0,0] = 0 => 2 Stopped
         1: 1, // [0,1] = 1 => 1 Moving down
         2: 0, // [1,0] = 2 => 0 Moving up
         3: 3 // [1,1] = 3 => 3 Error
      };
      let state = MAPPING[(switchUp * 2) + switchDown];
      let actualPosition;
      if (state === 2 || state === 3) {
         let timestamp = Date.now();
         if (accessory.context.cMoveState === 1) {
            aPos = Math.round(accessory.context.lastPosition - ((timestamp - accessory.context.startTimestamp) / accessory.context.percentDurationDown));
         } else if (accessory.context.cMoveState === 0) {
            aPos = Math.round(accessory.context.lastPosition + ((timestamp - accessory.context.startTimestamp) / accessory.context.percentDurationUp));
         } else {
            aPos = accessory.context.lastPosition;
         }
      }
      switch (state) {
         case 3:
         platform.log("[%s] Error with current movement state so resetting.", accessory.displayName);
         accessory.context.cTargetPos = aPos;
         accessory.context.targetTimestamp = Date.now() + 10;
         accessory.getService(Service.WindowCovering).updateCharacteristic(Characteristic.TargetPosition, aPos);
         break;
         case 2:
         if (accessory.context.cMoveState === 2) {
            platform.log("[%s] received request to stop moving. Nothing to do as blind is already stopped.", accessory.displayName);
            return;
         }
         platform.log("[%s] received request to stop moving. Updating new position [%s].", accessory.displayName, aPos);
         accessory.context.cTargetPos = aPos;
         accessory.context.targetTimestamp = Date.now() + 10;
         accessory.getService(Service.WindowCovering).updateCharacteristic(Characteristic.TargetPosition, aPos);
         break;
         case 1:
         if (accessory.context.cMoveState === 1) {
            platform.log("[%s] received request to move down. Nothing to do as blind is already moving down.", accessory.displayName);
            return;
         }
         if (accessory.context.cTargetPos === 0) {
            platform.log("[%s] received request to move down but was already fully closing. Stopping.", accessory.displayName);
         } else {
            platform.log("[%s] received request to move down so setting target position to 0.", accessory.displayName);
            accessory.getService(Service.WindowCovering).updateCharacteristic(Characteristic.TargetPosition, 0);
         }
         break;
         case 0:
         if (accessory.context.cMoveState === 0) {
            platform.log("[%s] received request to move up. Nothing to do as blind is already moving up.", accessory.displayName);
            return;
         }
         if (accessory.context.cTargetPos === 100) {
            platform.log("[%s] received request to move up but was already fully opening. Stopping.", accessory.displayName);
            
         } else {
            platform.log("[%s] received request to move up so setting target position to 100.", accessory.displayName);
            accessory.getService(Service.WindowCovering).updateCharacteristic(Characteristic.TargetPosition, 100);
         }
         break;
      }
      if ((state === 0 && accessory.context.cTargetPos === 0) || (state === 1 && accessory.context.cTargetPos === 100)) {
         accessory.context.cMoveState = 2;
         platform.log("[%s] received a request to stop moving.", accessory.displayName);
         let cTargetPos = accessory.context.cTargetPos;
         accessory.context.lastPosition = cTargetPos;
         accessory.getService(Service.WindowCovering).getCharacteristic(Characteristic.CurrentPosition).updateValue(cTargetPos);
         accessory.getService(Service.WindowCovering).getCharacteristic(Characteristic.TargetPosition).updateValue(cTargetPos);
         platform.log("[%s] has new target position of %s%", accessory.displayName, cTargetPos);
         let payload = {};
         payload.action = "update";
         payload.userAgent = "app";
         let deviceFromEwe = platform.devicesInEwe.get(hbDeviceId);
         payload.params = {};
         payload.params.switches = deviceFromEwe.params.switches;
         let switch0 = "off";
         let switch1 = "off";
         
         let state = accessory.context.cMoveState;
         
         switch (state) {
            case 2:
            switch0 = "off";
            switch1 = "off";
            break;
            case 1:
            switch0 = "off";
            switch1 = "on";
            break;
            case 0:
            switch0 = "on";
            switch1 = "off";
            break;
            default:
            platform.log("[%s] PositionState type error !", accessory.displayName);
            break;
         }
         
         payload.params.switches[accessory.context.switchUp].switch = switch0;
         payload.params.switches[accessory.context.switchDown].switch = switch1;
         payload.apikey = accessory.context.eweApiKey;
         payload.deviceid = accessory.context.hbDeviceId;
         payload.sequence = Math.floor(new Date());
         let string = JSON.stringify(payload);
         platform.sendWSMessage(string, function () {
            return;
         });
      }
      return;
   }
   
   externalFanUpdate (hbDeviceId, params) {
      let platform = this;
      if (!platform.log) {
         return;
      }
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
   
   externalThermostatUpdate (hbDeviceId, params) {
      let platform = this;
      if (!platform.log) {
         return;
      }
      let accessory = platform.devicesInHB.get(hbDeviceId);
      if (params.hasOwnProperty("switch") || params.hasOwnProperty("mainSwitch")) {
         let newState;
         if (params.hasOwnProperty("switch")) {
            newState = params.switch === "on" ? true : false;
         } else {
            newState = params.mainSwitch === "on" ? true : false;
         }
         accessory.getService(Service.Switch).updateCharacteristic(Characteristic.On, newState);
      }
      if (params.hasOwnProperty("currentTemperature") && accessory.getService(Service.TemperatureSensor)) {
         let currentTemp = params.currentTemperature != "unavailable" ? params.currentTemperature : 0;
         accessory.getService(Service.TemperatureSensor).updateCharacteristic(Characteristic.CurrentTemperature, currentTemp);
      }
      if (params.hasOwnProperty("currentHumidity") && accessory.getService(Service.HumiditySensor)) {
         let currentHumi = params.currentHumidity != "unavailable" ? params.currentHumidity : 0;
         accessory.getService(Service.HumiditySensor).updateCharacteristic(Characteristic.CurrentRelativeHumidity, currentHumi);
      }
      return;
   }
   
   externalOutletUpdate (hbDeviceId, params) {
      let platform = this;
      if (!platform.log) {
         return;
      }
      let accessory = platform.devicesInHB.get(hbDeviceId);
      accessory.getService(Service.Outlet).updateCharacteristic(Characteristic.On, params.switch === "on");
      return;
   }
   
   externalSingleLightUpdate (hbDeviceId, params) {
      let platform = this;
      if (!platform.log) {
         return;
      }
      let accessory = platform.devicesInHB.get(hbDeviceId);
      let newColour;
      let mode;
      if (params.hasOwnProperty("switch")) {
         accessory.getService(Service.Lightbulb).updateCharacteristic(Characteristic.On, params.switch === "on");
      } else if (params.hasOwnProperty("state")) {
         accessory.getService(Service.Lightbulb).updateCharacteristic(Characteristic.On, params.state === "on");
      }
      if (params.hasOwnProperty("bright")) {
         accessory.getService(Service.Lightbulb).updateCharacteristic(Characteristic.Brightness, params.bright);
      } else if (params.hasOwnProperty("brightness")) {
         accessory.getService(Service.Lightbulb).updateCharacteristic(Characteristic.Brightness, params.brightness);
      }
      
      //**************//
      // LED Strip L1 //
      //**************//
      if (params.hasOwnProperty("colorR")) {
         newColour = convert.rgb.hsl(params.colorR, params.colorG, params.colorB);
         accessory.getService(Service.Lightbulb).updateCharacteristic(Characteristic.Hue, newColour[0]);
         accessory.getService(Service.Lightbulb).updateCharacteristic(Characteristic.Saturation, newColour[1]);
      }
      
      //*********//
      // Bulb B1 //
      //*********//
      if (params.hasOwnProperty("zyx_mode")) {
         mode = parseInt(params.zyx_mode);
      } else if (params.hasOwnProperty("channel0")) {
         mode = 1;
      } else if (params.hasOwnProperty("channel2")) {
         mode = 2;
      } else {
         mode = 0;
      }
      if (mode === 1) {
         
         // between 25 and 255
         // three "types" -> "cold" "middle" "warm"
         
         // cold -> channel0 = 25->255 channel1 = 0
         // middle -> channel0 = channel1 = 25->255
         // warm -> channel0 = 0 channel1 = 25->255
         
         platform.log.warn("[%s] has been set to colour temperature mode which is not supported.", accessory.displayName);
      } else if (mode === 2) {
         if (parseInt(params.channel2) + parseInt(params.channel3) + parseInt(params.channel4) === 0) {
            accessory.getService(Service.Lightbulb).updateCharacteristic(Characteristic.On, false);
         } else {
            accessory.getService(Service.Lightbulb).updateCharacteristic(Characteristic.On, true);
            newColour = convert.rgb.hsv(parseInt(params.channel2), parseInt(params.channel3), parseInt(params.channel4));
            accessory.getService(Service.Lightbulb).updateCharacteristic(Characteristic.Hue, newColour[0]);
            accessory.getService(Service.Lightbulb).updateCharacteristic(Characteristic.Saturation, 100);
            accessory.getService(Service.Lightbulb).updateCharacteristic(Characteristic.Brightness, 100);
         }
      }
      return;
   }
   
   externalMultiLightUpdate (hbDeviceId, params) {
      let platform = this;
      if (!platform.log) {
         return;
      }
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
   
   externalSingleSwitchUpdate (hbDeviceId, params) {
      let platform = this;
      if (!platform.log) {
         return;
      }
      let accessory = platform.devicesInHB.get(hbDeviceId);
      accessory.getService(Service.Switch).updateCharacteristic(Characteristic.On, params.switch === "on");
      return;
   }
   
   externalMultiSwitchUpdate (hbDeviceId, params) {
      let platform = this;
      if (!platform.log) {
         return;
      }
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
   
   externalBridgeUpdate (hbDeviceId, params) {
      let platform = this;
      if (!platform.log) {
         return;
      }
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
   
   login (callback) {
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
      let webClient = request.createClient("https://" + platform.apiHost);
      webClient.headers["Authorization"] = "Sign " + sign;
      webClient.headers["Content-Type"] = "application/json;charset=UTF-8";
      webClient.post("/api/user/login", data, function (err, res, body) {
         if (err) {
            platform.log.error("An error occurred while logging in. [%s].", err);
            callback();
            return;
         }
         if (body.hasOwnProperty("error") && body.error === 301 && body.hasOwnProperty("region")) {
            let idx = platform.apiHost.indexOf("-");
            if (idx === -1) {
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
         platform.webClient = request.createClient("https://" + platform.apiHost);
         platform.webClient.headers["Authorization"] = "Bearer " + body.at;
         platform.getWebSocketHost(function () {
            callback(body.at);
         }.bind(this));
      }.bind(this));
   }
   
   getRegion (countryCode, callback) {
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
      }).join("&");
      let sign = platform.getSignature(dataToSign);
      if (platform.debug) platform.log("Info: getRegion signature [%s].", sign);
      let webClient = request.createClient("https://api.coolkit.cc:8080");
      webClient.headers["Authorization"] = "Sign " + sign;
      webClient.headers["Content-Type"] = "application/json;charset=UTF-8";
      webClient.get("/api/user/region?" + query, function (err, res, body) {
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
         let idx = platform.apiHost.indexOf("-");
         if (idx === -1) {
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
   }
   
   getWebSocketHost(callback) {
      let platform = this;
      if (!platform.log) {
         return;
      }
      var data = {};
      data.accept = "mqtt,ws";
      data.version = 8;
      data.ts = Math.floor(new Date().getTime() / 1000);
      data.nonce = nonce();
      data.appid = platform.appid;
      let webClient = request.createClient("https://" + platform.apiHost.replace("-api", "-disp"));
      webClient.headers["Authorization"] = "Bearer " + platform.authenticationToken;
      webClient.headers["Content-Type"] = "application/json;charset=UTF-8";
      webClient.post("/dispatch/app", data, function (err, res, body) {
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
         if (platform.debug) platform.log("Web socket host received [%s].", body.domain);
         platform.wsHost = body.domain;
         if (platform.ws) {
            platform.ws.url = "wss://" + body.domain + ":8080/api/ws";
         }
         callback(body.domain);
      }.bind(this));
   }
   
   relogin (callback) {
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
   }
   
   getChannelsByUIID (uiid) {
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
   
   getArguments (apiKey) {
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
   }
   
   getSignature (string) {
      return crypto.createHmac("sha256", "6Nz4n0xA8s8qdxQf2GqurZj2Fs55FUvM").update(string).digest("base64");
   }
   
   sendWSMessage (string, callback) {
      let platform = this;
      if (!platform.log) {
         return;
      }
      platform.delaySend = 0;
      const delayOffset = 280;
      let sendOperation = (string) => {
         if (!platform.webSocketOpen) {
            setTimeout(() => {
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
         if (platform.debug) platform.log("Socket was closed. It will reconnect automatically.");
         let interval;
         let waitToSend = (string) => {
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
   }
}

class WebSocketClient {
   constructor() {
      this.number = 0;
      this.pendingReconnect = false;
   }
   open (url) {
      this.url = url;
      this.instance = new WebSocket(this.url);
      this.instance.on("open", () => {
         this.onopen();
      });
      this.instance.on("message", (data, flags) => {
         this.number++;
         this.onmessage(data, flags, this.number);
      });
      this.instance.on("close", (e) => {
         switch (e.code) {
            case 1000:
            break;
            default:
            this.reconnect(e);
            break;
         }
         this.onclose(e);
      });
      this.instance.on("error", (e) => {
         switch (e.code) {
            case "ECONNREFUSED":
            this.reconnect(e);
            break;
            default:
            this.onerror(e);
            break;
         }
      });
   }
   send (data, option) {
      try {
         this.instance.send(data, option);
      } catch (e) {
         this.instance.emit("error", e);
      }
   }
   reconnect (e) {
      if (this.pendingReconnect) return;
      this.pendingReconnect = true;
      this.instance.removeAllListeners();
      let that = this;
      setTimeout(function () {
         that.pendingReconnect = false;
         that.open(that.url);
      }, 5000);
   }
}