// FarSight macOS activity helper. No permissions needed.
// Prints one JSON line every 2 seconds:
//   {"mic":1,"video":["Brave Browser","QuickTime Player"]}
//  - mic:   1 if any physical (non-virtual) input device is being used by some process
//           (CoreAudio kAudioDevicePropertyDeviceIsRunningSomewhere on the input scope).
//  - video: apps holding a "prevent display sleep" power assertion, which browsers and
//           video players create while a video is playing (e.g. Chromium's "Video Wake Lock").
#include <CoreAudio/CoreAudio.h>
#include <CoreFoundation/CoreFoundation.h>
#include <IOKit/pwr_mgt/IOPMLib.h>
#include <libproc.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

// ------------------------------------------------------------------ microphone

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

// ------------------------------------------------------------------ video (display-sleep assertions)

/** App display name for a pid: the outermost "X.app" in its path, else the process name. */
static void app_name_for_pid(pid_t pid, char *out, size_t cap) {
  char path[PROC_PIDPATHINFO_MAXSIZE] = {0};
  out[0] = 0;
  if (proc_pidpath(pid, path, sizeof path) > 0) {
    char *app = strstr(path, ".app/");
    if (app) {
      *app = 0;
      char *slash = strrchr(path, '/');
      snprintf(out, cap, "%s", slash ? slash + 1 : path);
      return;
    }
  }
  proc_name(pid, out, (uint32_t)cap);
}

/** Tools that keep the display awake without playing video. */
static int is_keep_awake_tool(const char *name) {
  static const char *ignore[] = {"caffeinate", "Amphetamine", "KeepingYouAwake", "Caffeine", "Lungo", "Theine",
                                 "powerd", "WindowServer", "coreaudiod", "FarSight", "Electron", NULL};
  for (int i = 0; ignore[i]; i++)
    if (strcmp(name, ignore[i]) == 0) return 1;
  return 0;
}

static int is_display_assertion(CFDictionaryRef assertion) {
  CFStringRef type = CFDictionaryGetValue(assertion, kIOPMAssertionTypeKey);
  if (!type) return 0;
  return CFEqual(type, kIOPMAssertionTypePreventUserIdleDisplaySleep) || CFEqual(type, kIOPMAssertionTypeNoDisplaySleep);
}

static void json_string(const char *s) {
  putchar('"');
  for (; *s; s++) {
    if (*s == '"' || *s == '\\') putchar('\\');
    if ((unsigned char)*s >= 0x20) putchar(*s);
  }
  putchar('"');
}

static void print_video_apps(void) {
  CFDictionaryRef byPid = NULL;
  printf("[");
  if (IOPMCopyAssertionsByProcess(&byPid) == kIOReturnSuccess && byPid) {
    CFIndex n = CFDictionaryGetCount(byPid);
    const void **keys = malloc(sizeof(void *) * n);
    const void **vals = malloc(sizeof(void *) * n);
    CFDictionaryGetKeysAndValues(byPid, keys, vals);
    char seen[16][128];
    int count = 0;
    for (CFIndex i = 0; i < n && count < 16; i++) {
      int pid = 0;
      CFNumberGetValue((CFNumberRef)keys[i], kCFNumberIntType, &pid);
      CFArrayRef list = (CFArrayRef)vals[i];
      int display = 0;
      for (CFIndex j = 0; j < CFArrayGetCount(list); j++)
        if (is_display_assertion((CFDictionaryRef)CFArrayGetValueAtIndex(list, j))) display = 1;
      if (!display) continue;
      char name[128];
      app_name_for_pid(pid, name, sizeof name);
      if (!name[0] || is_keep_awake_tool(name)) continue;
      int dup = 0;
      for (int k = 0; k < count; k++)
        if (strcmp(seen[k], name) == 0) dup = 1;
      if (dup) continue;
      snprintf(seen[count], sizeof seen[count], "%s", name);
      if (count++) putchar(',');
      json_string(name);
    }
    free(keys);
    free(vals);
    CFRelease(byPid);
  }
  printf("]");
}

int main(int argc, char **argv) {
  int once = argc > 1 && strcmp(argv[1], "-1") == 0;
  setvbuf(stdout, NULL, _IOLBF, 0);
  for (;;) {
    printf("{\"mic\":%d,\"video\":", mic_in_use());
    print_video_apps();
    printf("}\n");
    if (once) return 0;
    sleep(2);
    if (getppid() == 1) return 0; // parent exited
  }
}
