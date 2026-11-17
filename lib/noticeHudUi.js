import St from 'gi://St';
import Clutter from 'gi://Clutter';

/**
 * Generic island banner: icon, one bold line, one dim line.
 * Used for desktop notifications and timer events.
 * Left click => onActivate, right click => onDismiss.
 */
export function buildNoticeHud({ onActivate, onDismiss } = {}) {
    const box = new St.BoxLayout({
        style_class: 'brow-notice-hud',
        vertical: false,
        x_expand: true,
        y_expand: true,
        x_align: Clutter.ActorAlign.FILL,
        y_align: Clutter.ActorAlign.CENTER,
        opacity: 0,
        reactive: false,
    });

    const icon = new St.Icon({
        icon_name: 'preferences-system-notifications-symbolic',
        style_class: 'brow-notice-hud-icon',
        icon_size: 18,
        y_align: Clutter.ActorAlign.CENTER,
    });

    const texts = new St.BoxLayout({
        vertical: true,
        x_expand: true,
        y_align: Clutter.ActorAlign.CENTER,
    });
    const title = new St.Label({
        text: '',
        style_class: 'brow-notice-hud-title',
        x_expand: true,
    });
    const body = new St.Label({
        text: '',
        style_class: 'brow-notice-hud-body',
        x_expand: true,
    });
    title.clutter_text.ellipsize = 3; // Pango.EllipsizeMode.END
    body.clutter_text.ellipsize = 3;
    texts.add_child(title);
    texts.add_child(body);

    box.add_child(icon);
    box.add_child(texts);

    const clickId = box.connect('button-press-event', (_a, event) => {
        const button = event.get_button();
        if (button === 3)
            onDismiss?.();
        else
            onActivate?.();
        return Clutter.EVENT_STOP;
    });

    return {
        box,
        setReactive(on) {
            box.reactive = !!on;
        },
        update({ title: t, body: b, iconName }) {
            title.set_text(t ?? '');
            body.set_text(b ?? '');
            body.visible = !!b;
            if (iconName)
                icon.icon_name = iconName;
        },
        destroy() {
            try {
                box.disconnect(clickId);
            } catch (e) {
                // ignore
            }
        },
    };
}
