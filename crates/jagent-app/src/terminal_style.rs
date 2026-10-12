//! Mapping from persisted terminal preferences to the model style shared by all PTYs.
use jagent_core::settings::Settings;
use jagent_terminal::TerminalStyle;

pub fn from_settings(settings: &Settings) -> TerminalStyle {
    TerminalStyle {
        font_family: settings.terminal.font_family.clone().into(),
        font_size: gpui::px(settings.terminal.font_size as f32),
        line_height_multiplier: 1.2,
        padding: gpui::Edges::all(gpui::px(8.0)),
        palette: settings.terminal.palette.clone().into(),
        cursor_blink: settings.terminal.cursor_blink,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn maps_all_persisted_terminal_appearance_fields() {
        let mut settings = Settings::default();
        settings.terminal.font_family = "monospace-test".into();
        settings.terminal.font_size = 18;
        settings.terminal.cursor_blink = false;
        settings.terminal.palette = "one-dark".into();
        let style = from_settings(&settings);
        assert_eq!(style.font_family.as_ref(), "monospace-test");
        assert_eq!(style.font_size, gpui::px(18.0));
        assert!(!style.cursor_blink);
        assert_eq!(style.palette.as_ref(), "one-dark");
    }
}
