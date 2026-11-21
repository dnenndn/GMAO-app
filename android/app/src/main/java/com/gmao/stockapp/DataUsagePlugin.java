package com.gmao.stockapp;

import android.content.Context;
import android.content.SharedPreferences;
import android.net.TrafficStats;
import android.os.Process;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import org.json.JSONException;
import org.json.JSONObject;

import java.text.SimpleDateFormat;
import java.util.ArrayList;
import java.util.Collections;
import java.util.Date;
import java.util.Iterator;
import java.util.List;
import java.util.Locale;

/**
 * Data used by THIS app (all its network traffic, foreground and background), read from Android's
 * own per-app counters (TrafficStats). No permission needed.
 *
 *   sample({ state: "fg" | "bg" }) -> reads the counters, adds what was used since the previous
 *       sample to the day (attributed to the PREVIOUS state), remembers the new state, and returns
 *       { supported, days: { "2026-11-21": { fgRx, fgTx, bgRx, bgTx } } } for the last 35 days.
 *   reset() -> clears the history.
 *
 * The counters keep running while the app is closed, so traffic used in the background is counted
 * at the next sample. They restart at 0 when the phone reboots; that is handled.
 */
@CapacitorPlugin(name = "DataUsage")
public class DataUsagePlugin extends Plugin {

    private static final String PREFS = "gmao_data_usage";
    private static final int KEEP_DAYS = 35;

    private SharedPreferences prefs() {
        return getContext().getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    private static String today() {
        return new SimpleDateFormat("yyyy-MM-dd", Locale.US).format(new Date());
    }

    @PluginMethod
    public synchronized void sample(PluginCall call) {
        String state = "bg".equals(call.getString("state")) ? "bg" : "fg";
        int uid = Process.myUid();
        long rx = TrafficStats.getUidRxBytes(uid);
        long tx = TrafficStats.getUidTxBytes(uid);
        JSObject ret = new JSObject();
        if (rx == TrafficStats.UNSUPPORTED || tx == TrafficStats.UNSUPPORTED) {
            ret.put("supported", false);
            call.resolve(ret);
            return;
        }
        SharedPreferences p = prefs();
        long lastRx = p.getLong("lastRx", -1);
        long lastTx = p.getLong("lastTx", -1);
        String lastState = p.getString("lastState", "fg");
        try {
            JSONObject days = new JSONObject(p.getString("days", "{}"));
            if (lastRx >= 0 && lastTx >= 0) {
                long dRx = rx >= lastRx ? rx - lastRx : rx;   // counters restart at 0 after a reboot
                long dTx = tx >= lastTx ? tx - lastTx : tx;
                String day = today();
                JSONObject d = days.optJSONObject(day);
                if (d == null) d = new JSONObject();
                d.put(lastState + "Rx", d.optLong(lastState + "Rx", 0) + dRx);
                d.put(lastState + "Tx", d.optLong(lastState + "Tx", 0) + dTx);
                days.put(day, d);
            }
            List<String> keys = new ArrayList<>();
            Iterator<String> it = days.keys();
            while (it.hasNext()) keys.add(it.next());
            Collections.sort(keys);
            while (keys.size() > KEEP_DAYS) days.remove(keys.remove(0));
            p.edit().putLong("lastRx", rx).putLong("lastTx", tx).putString("lastState", state)
                    .putString("days", days.toString()).apply();
            ret.put("supported", true);
            ret.put("days", days);
            call.resolve(ret);
        } catch (JSONException e) {
            call.reject("Compteur illisible : " + e.getMessage());
        }
    }

    @PluginMethod
    public synchronized void reset(PluginCall call) {
        prefs().edit().remove("days").apply();
        call.resolve();
    }
}
