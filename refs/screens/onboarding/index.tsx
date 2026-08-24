/**
 * 構造のみの参照実装。色・書体・余白は var(--token) 経由。
 * 対応する craft 項目: C-033（初回起動）
 */
const OnboardingScreen = () => (
  <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--sp-3)', alignItems: 'flex-start' }}>
    <p style={{ fontSize: 'var(--fs-3)', color: 'var(--text)', margin: 0 }}>触りながら覚えられる導線</p>
    <p style={{ fontSize: 'var(--fs-1)', color: 'var(--text-muted)', margin: 0 }}>
      説明画面を連続で見せず、最初の操作の中で使い方を伝える
    </p>
    <button style={{ fontSize: 'var(--fs-1)', color: 'var(--text-muted)', background: 'none', border: 'none' }}>
      スキップする
    </button>
  </div>
)

export default OnboardingScreen
