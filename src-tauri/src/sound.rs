//! Synthesised sound effects: rendered to small WAV files once, then played natively
//! (`afplay` on macOS, `PlaySound` on Windows). No audio assets are bundled.
use std::f64::consts::PI;
use std::path::{Path, PathBuf};

const RATE: u32 = 44_100;

#[derive(Clone, Copy)]
enum Wave {
    Sine,
    Triangle,
}

struct Note {
    freq: f64,
    at: f64,
    dur: f64,
    wave: Wave,
    gain: f64,
}

fn chord(freqs: &[f64], step: f64, dur: f64, wave: Wave, gain: f64) -> Vec<Note> {
    freqs.iter().enumerate().map(|(i, f)| Note { freq: *f, at: i as f64 * step, dur, wave, gain }).collect()
}

fn notes_for(sound: &str, pair: &str) -> Option<Vec<Note>> {
    use Wave::*;
    let start = sound == "start";
    let n = match (sound, pair) {
        ("start" | "end", "chime") => chord(if start { &[659.25, 880.0, 1318.5] } else { &[1318.5, 880.0, 659.25] }, 0.12, 1.4, Sine, 0.35),
        ("start" | "end", "bell") => {
            let base = if start { 523.25 } else { 392.0 };
            vec![Note { freq: base, at: 0.0, dur: 2.4, wave: Sine, gain: 0.5 }, Note { freq: base * 3.0, at: 0.0, dur: 1.2, wave: Sine, gain: 0.12 }]
        }
        ("start" | "end", "harp") => {
            let mut f = vec![392.0, 493.88, 587.33, 783.99, 987.77];
            if !start {
                f.reverse();
            }
            chord(&f, 0.07, 1.6, Triangle, 0.22)
        }
        ("start" | "end", "bubbles") => {
            let mut idx = vec![0.0, 1.0, 2.0, 3.0];
            if !start {
                idx.reverse();
            }
            idx.iter().enumerate().map(|(k, i)| Note { freq: 500.0 + i * 180.0, at: k as f64 * 0.09, dur: 0.12, wave: Sine, gain: 0.3 }).collect()
        }
        ("start" | "end", "piano") => {
            let mut f = vec![261.63, 329.63, 392.0, 523.25];
            if !start {
                f.reverse();
            }
            chord(&f, 0.05, 1.8, Triangle, 0.25)
        }
        ("start" | "end", "whoosh") => return Some(vec![]), // rendered as noise sweep
        ("start" | "end", _) => return None,
        ("nudge", _) => chord(&[880.0, 1174.66], 0.1, 0.5, Sine, 0.25),
        ("blink", _) => chord(&[1567.98], 0.0, 0.6, Sine, 0.18),
        ("posture", _) => chord(&[783.99, 1046.5], 0.14, 0.7, Sine, 0.2),
        ("return", _) => chord(&[523.25, 659.25, 783.99], 0.09, 0.8, Sine, 0.2),
        _ => return None,
    };
    Some(n)
}

fn render(notes: &[Note], volume: f64) -> Vec<f64> {
    let len = notes.iter().map(|n| n.at + n.dur + 0.05).fold(0.0, f64::max);
    let mut buf = vec![0.0; (len * RATE as f64) as usize + 1];
    for n in notes {
        let start = (n.at * RATE as f64) as usize;
        let samples = (n.dur * RATE as f64) as usize;
        for i in 0..samples {
            let t = i as f64 / RATE as f64;
            let phase = (n.freq * t).fract();
            let osc = match n.wave {
                Wave::Sine => (2.0 * PI * phase).sin(),
                Wave::Triangle => 1.0 - 4.0 * (phase - 0.5).abs(),
            };
            // 15 ms attack, exponential decay to silence at the end of the note.
            let env = if t < 0.015 { t / 0.015 } else { (-(t - 0.015) * 6.9 / (n.dur - 0.015).max(0.01)).exp() };
            if let Some(s) = buf.get_mut(start + i) {
                *s += osc * env * n.gain * volume;
            }
        }
    }
    buf
}

/// Band-passed noise sweeping up (start) or down (end).
fn render_whoosh(up: bool, volume: f64) -> Vec<f64> {
    let dur = 1.1;
    let n = (dur * RATE as f64) as usize;
    let mut seed: u32 = 0x1234_5678;
    let (mut low, mut band) = (0.0, 0.0);
    (0..n)
        .map(|i| {
            seed ^= seed << 13;
            seed ^= seed >> 17;
            seed ^= seed << 5;
            let noise = (seed as f64 / u32::MAX as f64) * 2.0 - 1.0;
            let p = i as f64 / n as f64;
            let freq = if up { 300.0 * 10f64.powf(p) } else { 3000.0 * 10f64.powf(-p) };
            // State-variable band-pass filter.
            let f = 2.0 * (PI * freq / RATE as f64).sin();
            low += f * band;
            let high = noise - low - 0.4 * band;
            band += f * high;
            let env = if p < 0.4 { p / 0.4 } else { (1.0 - p) / 0.6 };
            band * env * volume * 0.8
        })
        .collect()
}

fn write_wav(path: &Path, samples: &[f64]) -> std::io::Result<()> {
    let data: Vec<u8> = samples.iter().flat_map(|s| ((s.clamp(-1.0, 1.0) * 32767.0) as i16).to_le_bytes()).collect();
    let mut out = Vec::with_capacity(44 + data.len());
    out.extend_from_slice(b"RIFF");
    out.extend_from_slice(&(36 + data.len() as u32).to_le_bytes());
    out.extend_from_slice(b"WAVEfmt ");
    out.extend_from_slice(&16u32.to_le_bytes());
    out.extend_from_slice(&1u16.to_le_bytes()); // PCM
    out.extend_from_slice(&1u16.to_le_bytes()); // mono
    out.extend_from_slice(&RATE.to_le_bytes());
    out.extend_from_slice(&(RATE * 2).to_le_bytes());
    out.extend_from_slice(&2u16.to_le_bytes());
    out.extend_from_slice(&16u16.to_le_bytes());
    out.extend_from_slice(b"data");
    out.extend_from_slice(&(data.len() as u32).to_le_bytes());
    out.extend_from_slice(&data);
    std::fs::write(path, out)
}

/// Render (once, cached) and return the WAV for a sound, or None if it's silent/unknown.
pub fn wav_for(cache_dir: &Path, sound: &str, pair: &str, volume: f64) -> Option<PathBuf> {
    let vol_step = (volume.clamp(0.0, 1.0) * 20.0).round() as u32; // 5% steps
    if vol_step == 0 {
        return None;
    }
    let path = cache_dir.join(format!("{sound}-{pair}-{vol_step}.wav"));
    if path.exists() {
        return Some(path);
    }
    let vol = vol_step as f64 / 20.0;
    let notes = notes_for(sound, pair)?;
    let samples = if notes.is_empty() { render_whoosh(sound == "start", vol) } else { render(&notes, vol) };
    std::fs::create_dir_all(cache_dir).ok()?;
    write_wav(&path, &samples).ok()?;
    Some(path)
}

pub fn play_file(path: &Path) {
    #[cfg(target_os = "macos")]
    {
        let _ = std::process::Command::new("afplay").arg(path).spawn();
    }
    #[cfg(windows)]
    {
        use std::os::windows::ffi::OsStrExt;
        use windows_sys::Win32::Media::Audio::{PlaySoundW, SND_ASYNC, SND_FILENAME, SND_NODEFAULT};
        let wide: Vec<u16> = path.as_os_str().encode_wide().chain(Some(0)).collect();
        unsafe { PlaySoundW(wide.as_ptr(), std::ptr::null_mut(), SND_FILENAME | SND_ASYNC | SND_NODEFAULT) };
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn renders_valid_wavs_and_caches() {
        let dir = std::env::temp_dir().join(format!("farsight-sound-test-{}", std::process::id()));
        for (s, p) in [("start", "chime"), ("end", "harp"), ("start", "whoosh"), ("blink", "chime")] {
            let path = wav_for(&dir, s, p, 0.6).expect("sound");
            let bytes = std::fs::read(&path).unwrap();
            assert_eq!(&bytes[0..4], b"RIFF");
            assert!(bytes.len() > 10_000, "{s}/{p} too short");
        }
        assert!(wav_for(&dir, "start", "none", 0.6).is_none());
        assert!(wav_for(&dir, "start", "chime", 0.0).is_none());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
