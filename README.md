# homebridge-ewelink-sonoff
There seems to be a variety of Homebridge plugins for eWeLink/Sonoff devices. My aim for this package is to bring together the best from all the different ones. I am constantly tinkering with the code, please feel free to post issues or pull requests.

This project was forked and based on the work of [homebridge-ewelink-max](https://github.com/howanghk/homebridge-ewelink).

Thanks :)
## Installation
Please see the [installation](https://github.com/thepotterfamily/homebridge-ewelink-sonoff/wiki/Installation) wiki page for guidance.

If you're feeling brave, I also have a beta version, often with new features or code changes that needs testing.

To switch between the different versions you can use Homebridge Config UI X to uninstall and reinstall the other. The configuration is exactly the same for both. Or, simply run these commands in the Homebridge terminal and then restart Homebridge. I keep the version numbers synchronised so if both packages have the same version then they are identical at that point in time.

#### Beta Version ([homebridge-ewelink-beta](https://github.com/thepotterfamily/homebridge-ewelink-beta))
To change to the beta version:
```bash
sudo npm uninstall homebridge-ewelink-sonoff -g
sudo npm install homebridge-ewelink-beta -g
```
#### Stable Version (homebridge-ewelink-sonoff)
To change to the stable version:
```bash
sudo npm uninstall homebridge-ewelink-beta -g
sudo npm install homebridge-ewelink-sonoff -g
```

## Supported Devices
Please see the [supported devices](https://github.com/thepotterfamily/homebridge-ewelink-sonoff/wiki/Supported-Devices) wiki page for guidance.

## About
#### My future plans/ideas
- Support for more devices is always a good thing.
#### Issues/Pull Requests
Please feel free to submit - the more the merrier!
## Credits
#### Device Owners
- @ozzyobr - for his continued support throughout, e.g. his work with colour conversion, his help with supporting the L1 LED strip.
- @attarawnneh - for his hours of patience whilst we trialled and errored with the RF Bridge - we got there I hope!
- @gmeiburg88 - for trusting my control of his baby's dimmer lamp to enable support for D1... and the heater too!
- @victorcooper - for allowing me to turn his room into a disco with lights and colours of his B1))
- @minws13 - for giving me remote access to his aquarium thermostat to add support for these devices.
#### Code
- @gbro115 → @MrTomAsh → @howanghk - the line of succession of this plugin that I forked from. Otherwise this package wouldn't exist!
- Web socket client implementation for auto reconnect [→](https://github.com/websockets/ws/wiki/Websocket-client-implementation-for-auto-reconnect) 
- Sonoff stateful blinds [→](https://github.com/manolab/homebridge-sonoff-stateful-blinds) 
