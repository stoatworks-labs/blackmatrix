// Desktop entry point. On mobile the platform calls the library directly.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    blackmatrix_mobile_lib::run()
}
