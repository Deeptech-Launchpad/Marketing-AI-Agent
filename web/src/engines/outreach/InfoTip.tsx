import { InfoTip as SharedInfoTip } from '../../components/ui/InfoTip'
import { HELP, type HelpKey } from './help'

// The Outreach screens' (i) buttons: the shared InfoTip, with Outreach's own
// short explanations (help.ts).

export function InfoTip({ topic, label }: { topic: HelpKey; label?: string }) {
  return <SharedInfoTip help={HELP[topic]} label={label} />
}
