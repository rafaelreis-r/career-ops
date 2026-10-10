# Modo: oferta -- Avaliação Completa A-F

Quando o candidato cola uma vaga (texto ou URL), entregar SEMPRE os 6 blocos:

**Candidate target weighting:** Read `target_roles.target_level`, `compensation.target_range`, `compensation.minimum`, and `location.country` from `config/profile.yml`. Before Block A of any full evaluation, require non-empty `target_roles.target_level` and `compensation.target_range` in `config/profile.yml`. If either is missing, stop without scoring or writing a report, tracker row, or application artifact; ask the candidate to set both. Give level and compensation decisive weight in the final 1-5 score. A strong CV match cannot justify 4.0+ for a below-target role without credible target-level pay potential; a below-target role in the candidate's home market without such evidence scores below 3.5. Verified target-level pay can offset a lower title. Do not infer people leadership from Staff or Principal titles alone. Compare stated pay in the same currency and period; pay below the minimum rules out a strong recommendation. Missing salary is unknown, not low: assess potential from evidenced scope, employer market, and pay currency without inventing a figure. A remote role paid from a higher-paying market may meet the compensation target at a lower title. Explain the reasoning in the report. Copy the final global score unchanged to the tracker and machine summary.

**US-only benefits:** A JD that offers 401(k) (also written 401k or 401 (k)), disability insurance, an FSA (Flexible Spending Account), or an HSA (Health Savings Account) is US employment, even when it says remote: a contractor or EOR hire abroad does not get these benefits. When the United States is not in `config/profile.yml` → `location.authorized_in`, treat it as an eligibility blocker regardless of `location.needs_sponsorship`: record `US-only employment: the JD offers {benefits found}` as a hard stop, score the final result below 3.5, and state that reason in the report.

**Perguntas em aberto, não deduções:** Apenas estas informações não declaradas são neutras e devem constar no relatório como perguntas ao recrutador, sem desconto em Red flags nem redução da nota global: salário ou faixa não publicados (inclusive confiabilidade da remuneração desconhecida por esse motivo), autorização de trabalho no nível ⚠️ Unstated, vaga remota sem países aceitos informados e modalidade de contratação contractor/EOR não declarada. Bloqueios explícitos continuam válidos: ⛔ No sponsorship, US-only benefits, restrição de local ou residência que exclui o candidato e regra do mercado local quando a própria vaga está abaixo do nível-alvo. Todas as demais regras e limites continuam valendo, inclusive o teto de Cultural signals em `modes/_shared.md` quando `culture_screen.deprioritize_if_absent: true` e faltam evidências dos critérios culturais exigidos.

**Substância acima do título:** A ausência de um título formal igual ao da vaga-alvo não reduz, por si só, o match com o currículo nem a nota global quando o escopo e os resultados comprovados do candidato cobrem as responsabilidades da vaga. Avaliar a substância, não o título. Gaps que o JD declara explicitamente (ferramentas nomeadas, um domínio, anos em um domínio regulado) continuam sendo gaps reais.

## Passo 0 -- Detecção de Arquétipo

Classificar a vaga em um dos 6 arquétipos (ver `_shared.md`). Se for híbrido, indicar os 2 mais próximos. Isso determina:
- Quais proof points priorizar no bloco B
- Como reescrever o summary no bloco E
- Quais histórias STAR preparar no bloco F

## Bloco A -- Resumo da Vaga

Tabela com:
- Arquétipo detectado
- Domain (platform/agentic/LLMOps/ML/enterprise)
- Função (build/consult/manage/deploy)
- Senioridade
- Remoto (full/híbrido/presencial)
- Tamanho do time (se mencionado)
- TL;DR em 1 frase

## Bloco B -- Match com o Currículo

Ler `cv.md`. Criar tabela com cada requisito do JD mapeado para linhas exatas do currículo.

**Adaptado ao arquétipo:**
- Se FDE → priorizar proof points de entrega rápida e proximidade com cliente
- Se SA → priorizar design de sistemas e integrações
- Se PM → priorizar product discovery e métricas
- Se LLMOps → priorizar evals, observability, pipelines
- Se Agentic → priorizar multi-agent, HITL, orquestração
- Se Transformation → priorizar gestão de mudança, adoção, escalabilidade

Seção de **gaps** com estratégia de mitigação para cada um. Para cada gap:
1. É um hard blocker ou um nice-to-have?
2. O candidato consegue demonstrar experiência adjacente?
3. Existe um projeto do portfolio que cubra esse gap?
4. Plano de mitigação concreto (frase para carta de apresentação, projeto rápido, etc.)

## Bloco C -- Nível e Estratégia

1. **Nível detectado** no JD vs **nível natural do candidato para esse arquétipo**
2. **Plano "vender senior sem mentir"**: frases específicas adaptadas ao arquétipo, conquistas concretas a destacar, como posicionar experiência de founder como vantagem
3. **Plano "se me downlevelearem"**: aceitar se a remuneração for justa, negociar revisão em 6 meses, critérios claros de promoção

## Bloco D -- Remuneração e Demanda

Usar WebSearch para:
- Salários atuais da vaga (Glassdoor, Levels.fyi, Blind, Glassdoor BR)
- Reputação de remuneração da empresa
- Tendência de demanda da vaga

Tabela com dados e fontes citadas. Se não houver dados, dizer isso em vez de inventar.

**Mercado Brasileiro -- Checks obrigatórios:**
- CLT ou PJ? Se CLT: considerar 13º, férias, FGTS, plano de saúde, VR/VA na comparação.
- Se PJ: qual o valor mensal? Calcular equivalente CLT.
- PLR mencionado? Quantos salários extras?
- Stock options / VSOP? Avaliar vesting, cliff e liquidez.
- Vale-refeição / vale-alimentação? Valor mensal?
- Plano de saúde? Coparticipação ou integral?

## Bloco E -- Plano de Personalização

| # | Seção | Estado atual | Mudança proposta | Por que |
|---|-------|-------------|------------------|---------|
| 1 | Summary | ... | ... | ... |
| ... | ... | ... | ... | ... |

Top 5 mudanças no currículo + Top 5 mudanças no LinkedIn para maximizar o match.

## Bloco F -- Plano de Entrevistas

6-10 histórias STAR+R mapeadas para requisitos do JD (STAR + **Reflection**):

| # | Requisito do JD | História STAR+R | S | T | A | R | Reflection |
|---|----------------|-----------------|---|---|---|---|------------|

A coluna **Reflection** captura o que foi aprendido ou o que seria feito diferente. Isso sinaliza senioridade — candidatos juniores descrevem o que aconteceu, candidatos seniores extraem lições.

**Story Bank:** Se `interview-prep/story-bank.md` existir, verificar se alguma dessas histórias já está lá. Se não, adicionar as novas. Com o tempo, isso constrói um banco reutilizável de 5-10 histórias-mestre que podem ser adaptadas para qualquer pergunta de entrevista.

**Selecionadas e enquadradas conforme o arquétipo:**
- FDE → enfatizar velocidade de entrega e proximidade com cliente
- SA → enfatizar decisões de arquitetura
- PM → enfatizar discovery e trade-offs
- LLMOps → enfatizar métricas, evals, production hardening
- Agentic → enfatizar orquestração, tratamento de erros, HITL
- Transformation → enfatizar adoção e mudança organizacional

Incluir também:
- 1 case study recomendado (qual projeto apresentar e como)
- Perguntas red-flag e como respondê-las (ex: "Por que você vendeu sua empresa?", "Você tinha reports diretos?")

---

## Pós-avaliação

**SEMPRE** após gerar os blocos A-F:

### 1. Salvar report .md

Salvar avaliação completa em `reports/{###}-{company-slug}-{YYYY-MM-DD}.md`.

- `{###}` = próximo número sequencial (3 dígitos, zero-padded). Para alocar de forma atômica e evitar condições de corrida, você DEVE executar `node reserve-report-num.mjs` para reservar o número (a saída retornará `{###}`), escrever o relatório, e em seguida executar `node reserve-report-num.mjs --release {###}` para liberar o sentinel.
- `{company-slug}` = nome da empresa em lowercase, sem espaços (usar hifens)
- `{YYYY-MM-DD}` = data atual

**Formato do report:**

```markdown
# Avaliação: {Empresa} -- {Vaga}

**Data:** {YYYY-MM-DD}
**Arquétipo:** {detectado}
**Score:** {X/5}
**URL:** {URL da vaga}
**PDF:** {caminho ou pendente}

---

## A) Resumo da Vaga
(conteúdo completo do bloco A)

## B) Match com o Currículo
(conteúdo completo do bloco B)

## C) Nível e Estratégia
(conteúdo completo do bloco C)

## D) Remuneração e Demanda
(conteúdo completo do bloco D)

## E) Plano de Personalização
(conteúdo completo do bloco E)

## F) Plano de Entrevistas
(conteúdo completo do bloco F)

## G) Rascunhos de Respostas para Candidatura
(apenas se score >= 4.5 -- rascunhos de respostas para o formulário de candidatura)

---

## Keywords extraídas
(lista de 15-20 keywords do JD para otimização ATS)
```

### 2. Registrar no tracker

**SEMPRE** registrar em `data/applications.md`:
- Próximo número sequencial
- Data atual
- Empresa
- Vaga
- Score: copiar sem recalcular a nota global final do relatório (1-5)
- Status: `Evaluated`
- PDF: ❌ (ou ✅ se a auto-pipeline gerou PDF)
- Report: link relativo ao report .md (ex: `[001](reports/001-company-2026-01-01.md)`)

**Formato do tracker:**

```markdown
| # | Data | Empresa | Vaga | Score | Status | PDF | Report |
```
