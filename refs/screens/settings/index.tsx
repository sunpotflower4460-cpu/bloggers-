/**
 * 構造のみの参照実装。色・書体・余白は var(--token) 経由。
 * 対応する craft 項目: C-005（設定項目が増えてきた）
 */
const groups = [
  { title: 'アカウント', items: ['プロフィール', 'メールアドレス'] },
  { title: '通知', items: ['プッシュ通知', 'メール通知'] },
  { title: 'その他', items: ['言語', 'ライセンス'] },
]

const SettingsScreen = () => (
  <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--sp-5)' }}>
    {groups.map((group) => (
      <section key={group.title} style={{ display: 'flex', flexDirection: 'column', gap: 'var(--sp-2)' }}>
        <h2 style={{ fontSize: 'var(--fs-2)', color: 'var(--text-muted)', margin: 0 }}>{group.title}</h2>
        <ul
          style={{
            listStyle: 'none',
            margin: 0,
            padding: 0,
            display: 'flex',
            flexDirection: 'column',
            gap: 'var(--sp-1)',
          }}
        >
          {group.items.map((item) => (
            <li key={item} style={{ padding: 'var(--sp-2) 0', fontSize: 'var(--fs-2)', color: 'var(--text)' }}>
              {item}
            </li>
          ))}
        </ul>
      </section>
    ))}
  </div>
)

export default SettingsScreen
