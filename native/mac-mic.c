// FarSight macOS microphone monitor.
// Prints one line every 2 seconds: "1" if any physical (non-virtual) input device is
// being used by some process, otherwise "0". Uses CoreAudio's
// kAudioDevicePropertyDeviceIsRunningSomewhere on the input scope; no permissions needed.
#include <CoreAudio/CoreAudio.h>
#include <stdio.h>
#include <stdlib.h>
#include <unistd.h>

static int has_input_streams(AudioObjectID dev) {
  AudioObjectPropertyAddress a = {kAudioDevicePropertyStreams, kAudioObjectPropertyScopeInput, kAudioObjectPropertyElementMain};
  UInt32 size = 0;
  return AudioObjectGetPropertyDataSize(dev, &a, 0, NULL, &size) == noErr && size > 0;
}

static int is_virtual(AudioObjectID dev) {
  AudioObjectPropertyAddress a = {kAudioDevicePropertyTransportType, kAudioObjectPropertyScopeGlobal, kAudioObjectPropertyElementMain};
  UInt32 t = 0, size = sizeof t;
  if (AudioObjectGetPropertyData(dev, &a, 0, NULL, &size, &t) != noErr) return 0;
  return t == kAudioDeviceTransportTypeVirtual || t == kAudioDeviceTransportTypeAggregate;
}

static int is_running(AudioObjectID dev) {
  AudioObjectPropertyAddress a = {kAudioDevicePropertyDeviceIsRunningSomewhere, kAudioObjectPropertyScopeInput, kAudioObjectPropertyElementMain};
  UInt32 running = 0, size = sizeof running;
  if (AudioObjectGetPropertyData(dev, &a, 0, NULL, &size, &running) != noErr) return 0;
  return running != 0;
}

static int mic_in_use(void) {
  AudioObjectPropertyAddress a = {kAudioHardwarePropertyDevices, kAudioObjectPropertyScopeGlobal, kAudioObjectPropertyElementMain};
  UInt32 size = 0;
  if (AudioObjectGetPropertyDataSize(kAudioObjectSystemObject, &a, 0, NULL, &size) != noErr) return 0;
  AudioObjectID *devs = malloc(size);
  if (!devs) return 0;
  int active = 0;
  if (AudioObjectGetPropertyData(kAudioObjectSystemObject, &a, 0, NULL, &size, devs) == noErr) {
    for (UInt32 i = 0; i < size / sizeof(AudioObjectID); i++) {
      if (has_input_streams(devs[i]) && !is_virtual(devs[i]) && is_running(devs[i])) {
        active = 1;
        break;
      }
    }
  }
  free(devs);
  return active;
}

int main(int argc, char **argv) {
  int once = argc > 1 && argv[1][0] == '-' && argv[1][1] == '1';
  setvbuf(stdout, NULL, _IOLBF, 0);
  for (;;) {
    printf("%d\n", mic_in_use());
    if (once) return 0;
    sleep(2);
    if (getppid() == 1) return 0; // parent exited
  }
}
