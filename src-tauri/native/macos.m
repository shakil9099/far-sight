// FarSight native macOS layer, linked into the app (no helper processes, no permissions needed).
//  - microphone in use (CoreAudio), video playback (display-sleep power assertions, IOKit)
//  - frontmost app (NSWorkspace), idle time and screen lock (CoreGraphics)
//  - window levels so break overlays cover fullscreen apps and every Space
#import <AppKit/AppKit.h>
#import <CoreAudio/CoreAudio.h>
#import <CoreGraphics/CoreGraphics.h>
#import <IOKit/pwr_mgt/IOPMLib.h>
#import <WebKit/WebKit.h>
#include <libproc.h>
#include <string.h>

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

/** 1 if any physical (non-virtual) microphone is being used by some process. */
int fs_mic_in_use(void) {
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

// ------------------------------------------------------------------ video

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

static int is_keep_awake_tool(const char *name) {
  static const char *ignore[] = {"caffeinate", "Amphetamine", "KeepingYouAwake", "Caffeine", "Lungo", "Theine",
                                 "powerd",     "WindowServer", "coreaudiod",     "FarSight", "farsight", NULL};
  for (int i = 0; ignore[i]; i++)
    if (strcmp(name, ignore[i]) == 0) return 1;
  return 0;
}

static int is_display_assertion(CFDictionaryRef assertion) {
  CFStringRef type = CFDictionaryGetValue(assertion, kIOPMAssertionTypeKey);
  return type && (CFEqual(type, kIOPMAssertionTypePreventUserIdleDisplaySleep) || CFEqual(type, kIOPMAssertionTypeNoDisplaySleep));
}

/** Apps holding a "keep display awake" assertion (what players do while video plays), newline-separated. */
int fs_video_apps(char *buf, int cap) {
  int used = 0;
  buf[0] = 0;
  CFDictionaryRef byPid = NULL;
  if (IOPMCopyAssertionsByProcess(&byPid) != kIOReturnSuccess || !byPid) return 0;
  CFIndex n = CFDictionaryGetCount(byPid);
  const void **keys = malloc(sizeof(void *) * n);
  const void **vals = malloc(sizeof(void *) * n);
  CFDictionaryGetKeysAndValues(byPid, keys, vals);
  for (CFIndex i = 0; i < n; i++) {
    int pid = 0;
    CFNumberGetValue((CFNumberRef)keys[i], kCFNumberIntType, &pid);
    CFArrayRef list = (CFArrayRef)vals[i];
    int display = 0;
    for (CFIndex j = 0; j < CFArrayGetCount(list); j++)
      if (is_display_assertion((CFDictionaryRef)CFArrayGetValueAtIndex(list, j))) display = 1;
    if (!display) continue;
    char name[256];
    app_name_for_pid(pid, name, sizeof name);
    if (!name[0] || is_keep_awake_tool(name) || strstr(buf, name)) continue;
    int len = (int)strlen(name);
    if (used + len + 2 > cap) break;
    memcpy(buf + used, name, len);
    used += len;
    buf[used++] = '\n';
    buf[used] = 0;
  }
  free(keys);
  free(vals);
  CFRelease(byPid);
  return used;
}

// ------------------------------------------------------------------ front app, idle, lock

/** Frontmost app name and bundle id. Returns 1 on success. */
int fs_front_app(char *name, int name_cap, char *bundle, int bundle_cap) {
  @autoreleasepool {
    NSRunningApplication *app = [[NSWorkspace sharedWorkspace] frontmostApplication];
    if (!app) return 0;
    snprintf(name, name_cap, "%s", app.localizedName.UTF8String ?: "");
    snprintf(bundle, bundle_cap, "%s", app.bundleIdentifier.UTF8String ?: "");
    return 1;
  }
}

/** Seconds since the last keyboard, mouse or trackpad input. */
double fs_idle_seconds(void) {
  return CGEventSourceSecondsSinceLastEventType(kCGEventSourceStateCombinedSessionState, kCGAnyInputEventType);
}

/** 1 while the login window / lock screen is up. */
int fs_screen_locked(void) {
  CFDictionaryRef dict = CGSessionCopyCurrentDictionary();
  if (!dict) return 0;
  int locked = 0;
  CFBooleanRef v = CFDictionaryGetValue(dict, CFSTR("CGSSessionScreenIsLocked"));
  if (v && CFBooleanGetValue(v)) locked = 1;
  CFRelease(dict);
  return locked;
}

// ------------------------------------------------------------------ windows

/** kind 0: break overlay (above everything, incl. fullscreen apps); 1: floating card/countdown. Main thread only. */
void fs_configure_overlay(void *nswindow, int kind) {
  NSWindow *w = (__bridge NSWindow *)nswindow;
  if (!w) return;
  w.level = kind == 0 ? kCGScreenSaverWindowLevel : NSPopUpMenuWindowLevel;
  w.collectionBehavior = NSWindowCollectionBehaviorCanJoinAllSpaces | NSWindowCollectionBehaviorFullScreenAuxiliary |
                         NSWindowCollectionBehaviorStationary | NSWindowCollectionBehaviorIgnoresCycle;
  w.hidesOnDeactivate = NO;
  if (kind == 1) w.hasShadow = NO;
}

// ------------------------------------------------------------------ debug snapshots

/** Write a PNG of a WKWebView's content (self-test only; needs no Screen Recording permission). */
void fs_snapshot_webview(void *webview, const char *path) {
  WKWebView *wv = (__bridge WKWebView *)webview;
  NSString *p = [NSString stringWithUTF8String:path];
  [wv takeSnapshotWithConfiguration:nil
                  completionHandler:^(NSImage *img, NSError *__unused err) {
                    if (!img) return;
                    CGImageRef cg = [img CGImageForProposedRect:NULL context:nil hints:nil];
                    NSBitmapImageRep *rep = [[NSBitmapImageRep alloc] initWithCGImage:cg];
                    [[rep representationUsingType:NSBitmapImageFileTypePNG properties:@{}] writeToFile:p atomically:YES];
                  }];
}
