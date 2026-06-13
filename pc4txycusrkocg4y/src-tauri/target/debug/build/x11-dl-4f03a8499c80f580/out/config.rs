pub mod config { pub mod libdir {
pub const xext: Option<&'static str> = Some("/usr/lib64");
pub const gl: Option<&'static str> = None;
pub const xcursor: Option<&'static str> = None;
pub const xxf86vm: Option<&'static str> = None;
pub const xft: Option<&'static str> = None;
pub const xinerama: Option<&'static str> = None;
pub const xi: Option<&'static str> = None;
pub const x11: Option<&'static str> = Some("/usr/lib64");
pub const xlib_xcb: Option<&'static str> = Some("/usr/lib64");
pub const xmu: Option<&'static str> = None;
pub const xrandr: Option<&'static str> = None;
pub const xtst: Option<&'static str> = None;
pub const xrender: Option<&'static str> = Some("/usr/lib64");
pub const xpresent: Option<&'static str> = None;
pub const xscrnsaver: Option<&'static str> = None;
pub const xt: Option<&'static str> = None;
}
}