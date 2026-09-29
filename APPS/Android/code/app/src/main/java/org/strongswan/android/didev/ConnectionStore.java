/* Copyright (C) didev. GPLv2; see LICENSE-GPLv2.txt. */
package org.strongswan.android.didev;

import android.content.Context;
import android.content.SharedPreferences;
import org.json.JSONArray;
import org.json.JSONObject;
import java.util.ArrayList;
import java.util.List;

public final class ConnectionStore
{
    public static final class Record
    {
        public String id, name, server, profileJson, profileUuid, keyAlias, state, ip, notAfter, lastRenewal, lastError;
        public JSONObject toJson() throws Exception
        { JSONObject v = new JSONObject(); v.put("id", id).put("name", name).put("server", server)
                .put("profile", profileJson).put("profileUuid", profileUuid).put("keyAlias", keyAlias).put("state", state)
                .put("ip", ip).put("notAfter", notAfter).put("lastRenewal", lastRenewal)
                .put("lastError", lastError); return v; }
        static Record fromJson(JSONObject v) throws Exception
        { Record r = new Record(); r.id=v.getString("id"); r.name=v.getString("name"); r.server=v.getString("server");
          r.profileJson=v.getString("profile"); r.profileUuid=v.optString("profileUuid", ""); r.keyAlias=v.getString("keyAlias"); r.state=v.optString("state", "Listo");
          r.ip=v.optString("ip", ""); r.notAfter=v.optString("notAfter", ""); r.lastRenewal=v.optString("lastRenewal", "");
          r.lastError=v.optString("lastError", ""); return r; }
    }
    private final SharedPreferences preferences;
    public ConnectionStore(Context context) { preferences = context.getSharedPreferences("didev-connections", Context.MODE_PRIVATE); }
    public synchronized List<Record> all() { List<Record> result = new ArrayList<>(); try { JSONArray all = new JSONArray(preferences.getString("items", "[]")); for (int i=0;i<all.length();i++) result.add(Record.fromJson(all.getJSONObject(i))); } catch (Exception ignored) { } return result; }
    public synchronized void save(Record record) { try { JSONArray all = new JSONArray(); boolean replaced=false; for (Record item: all()) { if (item.id.equals(record.id)) { all.put(record.toJson()); replaced=true; } else all.put(item.toJson()); } if (!replaced) all.put(record.toJson()); preferences.edit().putString("items", all.toString()).apply(); } catch (Exception e) { throw new IllegalStateException(e); } }
    public synchronized void remove(String id) { JSONArray all = new JSONArray(); try { for (Record item: all()) if (!item.id.equals(id)) all.put(item.toJson()); preferences.edit().putString("items", all.toString()).apply(); } catch (Exception e) { throw new IllegalStateException(e); } }
}
