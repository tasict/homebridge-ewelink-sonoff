# homebridge-ewelink-beta
There seems to be a variety of Homebridge plugins for eWeLink/Sonoff devices. My aim for this package is to bring together the best from all the different ones. I am constantly tinkering with the code, please feel free to post issues or pull requests.

If you want to give this package a try, by all means go ahead! But note there could be bugs. If you're looking for a stable version then I would recommend the project I forked this from - [homebridge-ewelink-max](https://github.com/howanghk/homebridge-ewelink).

More information about this package and how it's evolved from [homebridge-ewelink-max](https://github.com/howanghk/homebridge-ewelink) can be found at the end of this file.

Thanks :)
## Supported Devices
#### 🟢 Switches
The plugin **should** work with Sonoff switches (single and multi-channel).
- **Supported:** BASIC, MINI, 4CH
#### 🟠 Lights/Bulbs/Dimmers
The plugin **should** work with LED strips, dimmers etc. Giving you control of the colour/brightness of your device.
- **Supported:** L1, D1
- **Coming Soon:** B1, SLAMPHER
#### 🟢 Light Switches
The plugin **should** work with Sonoff light wall switches, and will be exposed as lights in Homebridge.
- **Supported:** T1-1C, T1-2C, T1-3C, TX-1C, TX-2C, TX-3C, KING-M4
#### 🟢 Outlets
The plugin **should** work with Sonoff outlets.
- **Supported:** POW
#### 🟢 RF Bridges
The plugin **should** work with the Sonoff Bridge, at the moment exposing motion sensors that will detect motion and notify Homebridge/HomeKit. Other devices connected to the RF bridge might cause issues.
- **Supported:** RF_BRIDGE
#### 🟢 Thermostats
The plugin **should** work with Sonoff Thermostat devices, showing the current temperature and relative humidity in Homebridge/HomeKit. I am looking for ways to relay target temperature changes from HomeKit apps back to eWeLink for consistency.
- **Supported:** TH10, TH16
#### 🟠 Fans
The plugin **might** work with Sonoff Fan devices. I need a kind person with the a device to assist!
- **Unsupported:** iFan02, iFan03
#### 🔴 Custom Devices (Blinds, Garage Doors)
> By custom devices I mean using a generic Sonoff multi-switch device to simulate a specific type of accessory that is HomeKit supported, for example blinds and garage doors.

The plugin **probably won't** work for blinds and **definitely won't** work for garage doors... yet.
## Installation
> Please note if you are currently using a different Sonoff plugin, then you will need to reset your Homebridge accessory cache and take note of the changed configuration options.
### Through Homebridge Config UI X
Simply go to the "Plugins" page, search `homebridge-ewelink-beta` and click "Install". You will be guided through the configuration.
### Manually
#### 1. Install
```bash
sudo npm i homebridge-ewelink-beta -g
```
#### 2. Configure
Add the following to your Homebridge configuration file in the appropriate place. These are the basic required fields.
> This plugin uses a single field for e-mail / phone number.
```json
{
   "platform" : "eWeLink",
   "name" : "eWeLink",
   "username" : "your-ewelink-username (either phone or email)",
   "password" : "your-ewelink-password",
   "countryCode" : "your-ewelink-country-code (eg 44 for UK, 1 for USA, 55 for Brazil)"
}
```
There are extra optional configuration options that can be configured via Homebridge-UI-X. Or you can browse the code to see them.
#### 3. Restart Homebridge
And voila your eWeLink devices *should* be added to your Homebridge instance.
## About
#### Changes from [homebridge-ewelink-max](https://github.com/howanghk/homebridge-ewelink)
> By *primary device* I mean the main device (whether it just have one switch or more).
> 
> By *secondary device* I mean an accessory that is created from a particular channel from a *primary device*.
- For general multi-switch devices, a primary device will now appear in Homebridge. Turning it on/off will turn all its secondary devices on/off respectively. The primary device will show as on if **any** of its secondary devices are on, otherwise it will show as off.
- If any device is externally updated (eg. physically or through eWeLink app/alexa/google), the plugin will no longer {notice the change and send a request to update the device with eWeLink} ([see here](https://github.com/howanghk/homebridge-ewelink/issues/96)).
- Certain devices are no longer removed and re-added upon Homebridge (re)start ([see here](https://github.com/howanghk/homebridge-ewelink/issues/105)).
#### My future plans/ideas
- Add/remove devices upon web socket message if possible.
- Support for more devices is always a good thing.
- TypeScript? I wouldn't know where to begin. So a 2000 line Javascript file is what it is!
#### My limitations
- I am not an expert in Javascript, but can certainly work around the template I have.
- The only devices I own are T1-1C and T1-2C light switches so I can only test with those.
#### Issues/Pull Requests
Please feel free to submit - the more the merrier! As the name suggests, this is still in beta so it's most likely you'll run into issues.
#### Credits
- @gbro115 → @MrTomAsh → @howanghk - the line of succession of this plugin that I forked from. Otherwise this wouldn't exist.
- @ozzyobr - for his work with colour conversion, help supporting the L1 LED strip and his continued support throughout :)
- @attarawnneh - for his patience while I trialled and errored with the RF Bridge - we got there I hope!
- @gmeiburg88 - for trusting my control of his baby's dimmer lamp to enable support for D1, and the heater!
