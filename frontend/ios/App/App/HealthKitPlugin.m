#import <Foundation/Foundation.h>
#import <Capacitor/Capacitor.h>

CAP_PLUGIN(HealthKitPlugin, "HealthKit",
           CAP_PLUGIN_METHOD(availability, CAPPluginReturnPromise);
           CAP_PLUGIN_METHOD(requestAccess, CAPPluginReturnPromise);
           CAP_PLUGIN_METHOD(getData, CAPPluginReturnPromise);
)
