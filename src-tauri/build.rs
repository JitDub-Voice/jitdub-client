fn main() {
    // интерфейс встраивается в бинарник при компиляции — пересобирать при любой правке ui/
    println!("cargo:rerun-if-changed=../ui");
    tauri_build::build()
}
