# homebridge-ewelink-beta
There seems to be a variety of Homebridge plugins for eWeLink/Sonoff devices.

My aim for this package is to bring together the best from all the different ones.

I am constantly tinkering with the code, please feel free to post issues or pull requests.

If you want to give this package a try, by all means go ahead! But note there could be bugs.

If you're looking for a stable version then I would recommend the project I forked this from - [homebridge-ewelink-max](https://github.com/howanghk/homebridge-ewelink).

More information about this package and how it's evolved from [homebridge-ewelink-max](https://github.com/howanghk/homebridge-ewelink) can be found at the end of this file.

Thanks :)
## Supported Devices
#### Switches/Outlets
The plugin **should** work with Sonoff switches (single and multi channel) and outlets.
#### Lights
The plugin **should** work with Sonoff light wall switches. Sonoff bulbs and LED strips are a work in progress.
#### Blinds/Fans/Thermostats
Most likely aren't working, mainly because I don't own the devices so it's difficult to test.
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
```json
{
   "platform" : "eWeLink",
   "name" : "eWeLink",
   "username" : "your-ewelink-username (either phone or email)",
   "password" : "your-ewelink-password",
   "countryCode" : "your-ewelink-country-code (eg 44 for UK or 1 for USA)"
}
```
#### 3. Restart Homebridge
And voila your eWeLink devices *should* be added to your Homebridge instance.
## About
#### Changes from [homebridge-ewelink-max](https://github.com/howanghk/homebridge-ewelink)
> By "primary device", I mean the main device (whether it just have one switch or more).
> 
> By "secondary device", I mean an accessory that is created from a particular channel from a "primary device".
- For multi-switch devices, a primary device will now appear in Homebridge. Turning it on/off will turn all its secondary devices on/off respectively. The primary device will show as on if **any** of its secondary devices are on, otherwise it will show as off.
- If any device is externally updated (eg. physically or through eWeLink app/alexa/google), the plugin will no longer {notice the change and send a request to update the device with eWeLink} ([see here](https://github.com/howanghk/homebridge-ewelink/issues/96)).
- Certain devices are no longer removed and re-added upon Homebridge (re)start ([see here](https://github.com/howanghk/homebridge-ewelink/issues/105)).
#### Current issues that need addressing
- I have no idea if this plugin works correctly with devices apart from what I own (see below).
- Definitely won't work for thermostats/blinds as I need to make some changes.
#### My future plans/ideas
- Add/remove devices upon web socket message if possible?
- Add config option to disable master devices showing.
- Support for more devices is always a good thing. If you have a device and could help me with testing let me know!
#### My limitations
- I am not an expert in javascript, but can certainly work around the template I have.
- The only devices I own are T1-1C and T1-2C light switches so I can only test with those.
