// Stand-in for `expo-device` under jest: a plausible device so enrolment tests have real-looking
// `modelName`/`osVersion`/`deviceName` without a native binding.
module.exports = { isDevice: true, modelName: 'iPhone15,2', osVersion: '18.1', deviceName: 'iPhone de teste', osName: 'iOS' };
