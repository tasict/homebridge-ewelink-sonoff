# homebridge-ewelink-sonoff
There seems to be a variety of Homebridge plugins for eWeLink/Sonoff devices. My aim for this package is to bring together the best from all the different ones. I am constantly tinkering with the code, please feel free to post issues or pull requests.

This project was forked and based on the work of [homebridge-ewelink-max](https://github.com/howanghk/homebridge-ewelink).

Thanks :)
## Supported Devices
#### 🟢 Switches
The plugin **should** work with Sonoff switches (single and multi-channel).
- **Supported:** BASIC, MINI, 4CH
#### 🟢 Light Bulbs
The plugin **should** work with Sonoff bulbs and LED strips, giving you control of the brightness and colour (🇬🇧!) of your device.
- **Supported:** B1, L1
#### 🟢 Light Switches
The plugin **should** work with Sonoff light and dimmer switches, and will be exposed as lights in Homebridge.
- **Supported:** T1-1C, T1-2C, T1-3C, TX-1C, TX-2C, TX-3C, KING-M4, SLAMPHER, D1
#### 🟢 Outlets
The plugin **should** work with Sonoff outlets. Unfortunately there is no native method in HomeKit to show power readings.
- **Supported:** POW
#### 🟢 RF Bridges
The plugin **should** work with the Sonoff Bridge, at the moment exposing motion sensors that will detect motion and notify Homebridge/HomeKit. Other devices connected to the RF bridge might cause issues.
- **Supported:** RF_BRIDGE
#### 🟢 Thermostats
The plugin **should** work with Sonoff Thermostat devices, exposing a temperature sensor, a humidity sensor (if the device supports it) and a switch in Homebridge for the connected device.
- **Supported:** TH10, TH16
#### 🟠 Fans
The plugin **might** work with Sonoff Fan devices. I need a kind person with the a device to assist!
- **Needs Testing:** iFan02, iFan03
#### 🟠 Custom Devices
> By custom devices I mean using a generic Sonoff device to simulate a specific type of accessory that is HomeKit supported (e.g. blinds and garage doors).
- **Needs Testing:** Blinds (with a two-channel device)
- **Needs Testing:** Garage Doors (with a one-channel device)
## Installation
> Please note if you are currently using a different Sonoff plugin, then you will need to reset your Homebridge accessory cache and take note of the changed configuration options.
### Through Homebridge Config UI X
Simply go to the "Plugins" page, search `homebridge-ewelink-sonoff` and click "Install". You will be guided through the configuration.
### Manually
#### 1. Install
```bash
sudo npm i homebridge-ewelink-sonoff -g
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
#### My future plans/ideas
- Support for more devices is always a good thing.
- TypeScript? I wouldn't know where to begin. So a ~~2000~~ 1800 line Javascript file is what it is!
#### Issues/Pull Requests
Please feel free to submit - the more the merrier!
#### Credits
- @gbro115 → @MrTomAsh → @howanghk - the line of succession of this plugin that I forked from. Otherwise this package wouldn't exist!
- @ozzyobr - for his continued support throughout, e.g. his work with colour conversion, his help with supporting the L1 LED strip.
- @attarawnneh - for his hours of patience whilst we trialled and errored with the RF Bridge - we got there I hope!
- @gmeiburg88 - for trusting my control of his baby's dimmer lamp to enable support for D1... and the heater too!
- @victorcooper - for allowing me to turn his room into a disco with lights and colours of his B1))
- @minws13 - for giving me remote access to his aquarium thermostat to add support for these devices.

Thank you to all 😃.
