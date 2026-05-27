# 捉迷藏控制台

這是獨立於玩家網站的控制台網站，預設跑在：

```text
http://127.0.0.1:5178
```

啟動方式：

```powershell
node server.mjs
```

控制台登入後會讀取 Supabase `game_players`，顯示同一房間內紅隊和綠隊所有玩家位置。

公開預覽：

```text
https://afraid-rats-refuse.loca.lt
```

## 權限設定

請先在玩家專案的 Supabase SQL Editor 執行最新：

```text
捉迷藏/supabase/schema.sql
```

接著把控制員帳號加入 `control_operators`。先用控制員 email 在玩家 APP 或控制台註冊登入一次，再到 Supabase `auth.users` 找到該 email 的 `id`，執行：

```sql
insert into public.control_operators (user_id, email)
values ('貼上控制員 user id', '控制員 email')
on conflict (user_id) do update set email = excluded.email;
```

沒有加入 `control_operators` 的一般玩家帳號，仍然只能照遊戲規則讀取敵隊位置。
