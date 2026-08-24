import { useState } from 'react'
import ListScreen from '../screens/list'
import ListEmptyScreen from '../screens/list-empty'
import DetailScreen from '../screens/detail'
import SettingsScreen from '../screens/settings'
import NavigationScreen from '../screens/navigation'
import EmptyScreen from '../screens/empty'
import EmptySearchScreen from '../screens/empty-search'
import LoadingScreen from '../screens/loading'
import ErrorScreen from '../screens/error'
import FormScreen from '../screens/form'
import ProgressScreen from '../screens/progress'
import ConfirmScreen from '../screens/confirm'
import OfflineScreen from '../screens/offline'
import FormLongScreen from '../screens/form-long'
import SelectScreen from '../screens/select'
import InteractionScreen from '../screens/interaction'
import ScrollScreen from '../screens/scroll'
import OnboardingScreen from '../screens/onboarding'
import FeedbackScreen from '../screens/feedback'
import LabelsScreen from '../screens/labels'
import TypographyScreen from '../screens/typography'
import NumbersScreen from '../screens/numbers'
import DatetimeScreen from '../screens/datetime'
import EmphasisScreen from '../screens/emphasis'

const screens = [
  { path: 'list', label: 'C-001 リスト（項目多い）', Component: ListScreen },
  { path: 'list-empty', label: 'C-002 リスト（項目少ない）', Component: ListEmptyScreen },
  { path: 'detail', label: 'C-003/004 詳細', Component: DetailScreen },
  { path: 'settings', label: 'C-005 設定', Component: SettingsScreen },
  { path: 'navigation', label: 'C-006/030 遷移', Component: NavigationScreen },
  { path: 'empty', label: 'C-010 空状態', Component: EmptyScreen },
  { path: 'empty-search', label: 'C-011 検索結果ゼロ', Component: EmptySearchScreen },
  { path: 'loading', label: 'C-012 読み込み中', Component: LoadingScreen },
  { path: 'error', label: 'C-013 エラー（通信）', Component: ErrorScreen },
  { path: 'form', label: 'C-014/021/023 フォーム', Component: FormScreen },
  { path: 'progress', label: 'C-015 処理中', Component: ProgressScreen },
  { path: 'confirm', label: 'C-016 取り消せない操作', Component: ConfirmScreen },
  { path: 'offline', label: 'C-017 オフライン', Component: OfflineScreen },
  { path: 'form-long', label: 'C-020 長いフォーム', Component: FormLongScreen },
  { path: 'select', label: 'C-022 選択肢が多い', Component: SelectScreen },
  { path: 'interaction', label: 'C-031 タップ反応', Component: InteractionScreen },
  { path: 'scroll', label: 'C-032 スクロール固定', Component: ScrollScreen },
  { path: 'onboarding', label: 'C-033 初回起動', Component: OnboardingScreen },
  { path: 'feedback', label: 'C-034 音と触覚', Component: FeedbackScreen },
  { path: 'labels', label: 'C-040 ラベル', Component: LabelsScreen },
  { path: 'typography', label: 'C-041 文字階層', Component: TypographyScreen },
  { path: 'numbers', label: 'C-042 数字と単位', Component: NumbersScreen },
  { path: 'datetime', label: 'C-043 日時', Component: DatetimeScreen },
  { path: 'emphasis', label: 'C-051 強調', Component: EmphasisScreen },
]

export default function App() {
  const [active, setActive] = useState(screens[0].path)
  const current = screens.find((s) => s.path === active) ?? screens[0]

  return (
    <div style={{ display: 'flex', minHeight: '100vh' }}>
      <nav style={{ padding: 'var(--sp-3)', borderRight: '1px solid var(--border)' }}>
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
          {screens.map((s) => (
            <li key={s.path}>
              <button
                onClick={() => setActive(s.path)}
                style={{
                  font: 'inherit',
                  fontSize: 'var(--fs-1)',
                  color: s.path === active ? 'var(--text)' : 'var(--text-muted)',
                  background: 'none',
                  border: 'none',
                  textAlign: 'left',
                  padding: 'var(--sp-1) 0',
                }}
              >
                {s.label}
              </button>
            </li>
          ))}
        </ul>
      </nav>
      <main style={{ flex: 1, padding: 'var(--sp-4)' }}>
        <current.Component />
      </main>
    </div>
  )
}
