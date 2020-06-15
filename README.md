# homebridge-ewelink-beta
There seems to be a variety of Homebridge plugins for eWeLink/Sonoff devices.

My aim for this package is to bring together the best from all the different ones.

I am constantly tinkering with the code, please feel free to post issues or pull requests.

If you want to give this package a try, by all means go ahead! But note there could be bugs.

If you're looking for a stable version then I would recommend the project I forked this from - [homebridge-ewelink-max](https://github.com/howanghk/homebridge-ewelink).

More information about this package and how it's evolved from [homebridge-ewelink-max](https://github.com/howanghk/homebridge-ewelink) can be found at the end of this file.

Thanks :)
## Installation
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
- The new master device is only reactive to external changes. Currently trying to change the master device and/or its secondary devices through Homebridge can be quite temperamental! 
- Secondary device characteristics (eg. serial number, firmware) are correctly recorded when added to Homebridge but then lose their correct characteristics when restarting Homebridge.
- I have no idea if this plugin works correctly with devices apart from what I own (see below).
#### My future plans/ideas
- Add/remove devices upon web socket message if possible?
- Add config option to disable master devices showing.
- Support for more devices is always a good thing. If you have a device and could help me with testing let me know!
#### My limitations
- I am not an expert in javascript, but can certainly work around the template I have
- The only devices I own are T1-1CH and T1-2CH light switches so I can only test with those.