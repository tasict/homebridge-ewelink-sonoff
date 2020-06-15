# homebridge-ewelink-beta

## About

There seems to be a variety of Homebridge plugins for eWeLink/Sonoff devices.

My aim for this package is to bring together the best from all the different ones.

I am constantly tinkering with the code, please feel free to post issues or pull requests.

If you want to give this package a try, by all means go ahead! But note there could be bugs.

If you're looking for a stable version then I would recommend the project I forked this from - [homebridge-ewelink-max](https://github.com/howanghk/homebridge-ewelink).

Thanks :)

## Installation

#### 1. Install

```bash
sudo npm i homebridge-ewelink-beta -g
```

#### 2. Configure
The plugin can either be configured through homebridge-config-ui-x, or add the following to your Homebridge configuration file.

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

## My Plans

- add/remove devices upon websocket message if possible?
- multi switch flicking issue
- switching updating still isnt perfect
- characteristics for multi channel devices not loading properly (eg firmware)