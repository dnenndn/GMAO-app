# Notifications that arrive on Xiaomi / Redmi / POCO phones (MIUI, HyperOS)

Xiaomi's battery manager closes apps in the background, so push notifications from Stock GMAO (new DA to approve,
fuel alert, DI, ...) can arrive late or never. Do these steps **once on each Xiaomi phone**. Menu names vary a little
between MIUI and HyperOS and between languages; the English name is given first, the usual French one in brackets.
(I could not test this on a real phone: if a menu is named differently, look for the same idea.)

1. **Autostart** - Settings > Apps > Manage apps > *Stock GMAO* > **Autostart** (Démarrage automatique): ON.
2. **Battery** - same screen > **Battery saver** (Économie d'énergie) > choose **No restrictions** (Aucune restriction).
   On some versions: Settings > Battery > App battery saver > Stock GMAO > No restrictions.
3. **Notifications** - same screen > **Notifications** > allow all, and set the channel importance to *Urgent / Pop-up*.
   Allow **Show on lock screen**.
4. **Lock the app in the recent apps list** - open the recent apps screen, long-press the Stock GMAO card
   (or tap the menu icon on the card) and choose the **padlock** (Verrouiller). Swiping the app away afterwards no
   longer kills its notifications.
5. **Do Not Disturb** - if you use it, add Stock GMAO to the allowed apps.
6. In **Settings > Battery > Battery saver / Power saving mode** keep the mode **off** during work hours.

Test: from another phone, create a DI or a DA; the notification must appear within a few seconds even when the
screen is off. If it only appears when you open the app, step 1 or 2 was not applied.

General reference for every brand: <https://dontkillmyapp.com/xiaomi>
