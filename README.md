# SyntaxCoder

Agentowy asystent kodu w VS Code działający na **Twoim własnym modelu w [LM Studio](https://lmstudio.ai/)**: lokalnie albo na innym komputerze w sieci. Rozmawiasz w czacie, a agent czyta i edytuje pliki, tworzy foldery i uruchamia komendy w projekcie.

Kod nie trafia do żadnej chmury. Wszystko idzie tylko do serwera LM Studio, który sam wskażesz. Wyjątek to przełącznik **Web** (domyślnie wyłączony): wtedy agent może pytać serwery MCP w internecie, opisane niżej.

## Funkcje

- Czat w panelu bocznym (ikona **SxC** na pasku aktywności) ze streamingiem odpowiedzi i podglądem „myślenia” modelu.
- Narzędzia agenta: `read_file`, `write_file`, `edit_file`, `create_dir`, `move_path`, `delete_path`, `list_dir`, `glob`, `grep`, `get_diagnostics`, `run_command`, `open_file`, `update_plan`.
- Plan zadania: przy zadaniach z kilkoma krokami agent prowadzi plan (`update_plan`), widoczny w czacie jako lista kroków ze stanem (○ do zrobienia, ▸ w toku, ✓ zrobione).
- Zgoda na każdy zapis pliku i każdą komendę (przyciski **Zezwól / Odrzuć**). Można to wyłączyć w ustawieniach.
- Przełącznik **Auto** przy polu wiadomości włącza tryb autonomiczny (po potwierdzeniu).
- Przełącznik **Recenzent**: gdy agent zmieni pliki, drugi przebieg modelu (tylko z narzędziami do odczytu) sprawdza w plikach, czy polecenie zostało wykonane. Braki wracają do agenta, maksymalnie 4 rundy poprawek.
- Przełącznik **Plan** (tryb planu): agent najpierw czyta kod (tylko narzędzia do odczytu) i zapisuje plan kroków. Nic się nie zmienia, dopóki nie klikniesz **Wykonaj plan** pod planem. Zamiast tego możesz napisać, co w planie zmienić, a agent zapisze nowy plan. Przy wykonaniu agent odhacza kolejne kroki, a recenzent (gdy włączony) sprawdza każdy krok planu.
- Przełącznik **Inline** (inline suggestions): gdy piszesz w edytorze, model proponuje dalszy ciąg kodu szarym tekstem. **Tab** przyjmuje podpowiedź, **Esc** ją odrzuca. Podpowiedź pojawia się po krótkiej przerwie w pisaniu i kończy się na domkniętym bloku: pętla czy `if` przychodzi w całości, do swojego `}` (w Pythonie do końca wcięcia), a nigdy nie zostaje urwana w środku. W środku linii podpowiedź pojawia się tylko wtedy, gdy za kursorem są same spacje albo nawiasy zamykające. Gdy piszesz to, co jest w szarym tekście, reszta zostaje bez nowego zapytania. Z modelami Qwen-Coder podpowiedź widzi też najbardziej podobne fragmenty innych otwartych plików w tym samym języku (do ok. 3000 znaków), więc korzysta z funkcji i typów zdefiniowanych gdzie indziej. Te fragmenty też trafiają do LM Studio, z wyjątkiem plików z sekretami. Model dostaje kod przed kursorem i za nim (fill-in-the-middle). Podpowiedzi biorą model wybrany w czacie. Inny model ustawisz w `syntaxcoder.completionModel`. Najlepiej sprawdza się jeden model do kodu typu MoE do wszystkiego, np. Qwen3-Coder-30B-A3B Instruct: na MacBooku Pro M1 Max (MLX 8-bit) podpowiada w 0,7–1,2 s, a agent dostaje odpowiedź w 1–4 s. Gęste modele są wolniejsze: Qwen2.5-Coder-14B podpowiada w ok. 2 s, a model 27B w 3–7 s. Przy mniejszej ilości pamięci wybierz mały model, np. Qwen2.5-Coder 1.5B albo 7B. Gdy w LM Studio jest włączone **Only Keep Last JIT Loaded Model**, dwa różne modele (czat i podpowiedzi) wyrzucają się nawzajem z pamięci i każde przełączenie trwa kilkanaście sekund. Szablon FIM rozszerzenie dobiera po nazwie modelu: Qwen-Coder (domyślny), DeepSeek-Coder, StarCoder albo CodeLlama.
- Przełącznik **Web**: agent dostaje narzędzia serwerów MCP po HTTP z `syntaxcoder.mcpServers`. Domyślnie to [context7](https://context7.com) (aktualna dokumentacja bibliotek), [grep.app](https://grep.app) (wyszukiwanie kodu na GitHubie) i [DeepWiki](https://deepwiki.com) (dokumentacja repozytoriów). Włączenie przełącznika pokazuje ostrzeżenie z listą serwerów: zapytania wychodzą poza Twoją sieć i mogą zawierać fragmenty kodu. Po potwierdzeniu agent woła te serwery bez pytania, a w czacie widać każde wywołanie. Na serwer, który się łączy, zadanie czeka najwyżej 4 s, a wolny serwer dołącza w następnym zadaniu. Serwer, który nie odpowiada, wypada z listy z jedną krótką informacją. Kolejną próbę połączenia z nim rozszerzenie robi po 5 minutach, więc martwy serwer nie spowalnia kolejnych zadań.
- Agent, który kręci się w kółko, dostaje szturchańca zamiast twardego stopu. Rozszerzenie wykrywa:
  - to samo wywołanie z tym samym wynikiem;
  - to samo wywołanie, które za każdym razem kończy się błędem;
  - serię nieudanych zmian jednego pliku;
  - zmianę, która niczego nie zmieniła;
  - edycje, które cofają plik do stanu, w którym już był.

  Najpierw agent dostaje wskazówkę, co dokładnie się powtarza. Potem robi turę namysłu bez narzędzi: mówi, co próbował i co zrobi inaczej. Dopiero gdy i to nie pomoże, kończy pracę własnym podsumowaniem: co zrobione, co nie i co blokuje. Tak samo kończy się praca po wykorzystaniu limitu rund narzędzi.
- Wskaźnik generowania za licznikiem kontekstu. Tekst i myślenie przychodzą na żywo: `120 tok · 52 tok/s`. Gdy model pisze argumenty narzędzia, wskaźnik pokazuje nazwę narzędzia i rosnącą liczbę tokenów, np. `write_file ~640 tok`. LM Studio oddaje te argumenty dopiero w całości (żadne jego API nie wysyła ich na bieżąco), więc `~` to szacunek: zmierzone tempo modelu razy czas pisania. Tempo jest pamiętane osobno dla każdego modelu; nowy model pokazuje `write_file …`, dopóki jego tempo nie zostanie zmierzone. Gdy serwer obsługuje naraz inne zapytania, szacunek może się rozjechać. Dopóki LM Studio nic nie wysyła, wskaźnik pokazuje `prompt…`. Po odpowiedzi zostaje dokładna liczba tokenów z LM Studio, np. `192 tok`, i tempo, gdy było co mierzyć.
- Licznik kontekstu obok nazwy modelu, np. `85.2k / 262k`: ile tokenów zajmuje rozmowa i ile mieści załadowany model. Powyżej 3/4 kontekstu licznik zmienia kolor. Długa rozmowa spowalnia każdą odpowiedź, a **Nowa rozmowa** go zeruje. Długie wyniki narzędzi (np. całe pliki) z poprzednich zadań zostają w historii tylko jako krótka notka, więc kolejne pytania nie wysyłają ich od nowa. Agent przeczyta plik ponownie, gdy go potrzebuje.
- Suwak **Myślenie** za nazwą modelu: poziom myślenia modelu. Pozycje suwaka to poziomy, które LM Studio podaje dla wybranego modelu (`capabilities.reasoning` w `/api/v1/models`), np. Qwen3.6 ma tylko wył./wł., a Qwen3.8 wył., niskie, średnie, bardzo wysokie i wł. Zmiana modelu przestawia suwak na poziomy nowego modelu. Model bez poziomów (np. Qwen3 Coder) nie ma suwaka i nie dostaje parametru. Wybór trafia do modelu jako `reasoning_effort` (wył. = `none`, wł. = domyślne myślenie modelu) i działa od następnego zapytania, także w trakcie zadania. Mniej myślenia = szybsze odpowiedzi, np. przy szukaniu literówek. Starsze LM Studio bez `/api/v1` nie pokazuje suwaka.
- Wybór modelu z listy modeli załadowanych w LM Studio.
- **Dodaj zaznaczenie do czatu** w menu kontekstowym edytora.
- Interfejs po angielsku, niemiecku, francusku i polsku.

## Wymagania

- VS Code 1.90 lub nowszy.
- LM Studio z uruchomionym serwerem (**Developer → Local Server**) i załadowanym modelem, który obsługuje *tool calling* (np. Qwen3).
- Jeśli LM Studio działa na innym komputerze, włącz w nim **Allow remote connections**.

## Szybki start

1. Zainstaluj rozszerzenie i kliknij ikonę **SxC** na pasku aktywności.
2. Na pasku panelu kliknij ikonę zębatki (**Ustawienia i połączenie**) i wpisz host i port LM Studio (np. `192.168.1.20` i `1234`). Serwer za reverse proxy z HTTPS: zaznacz **HTTPS** (port zmieni się na 443) albo wpisz od razu `https://lm.example.com`. Jeśli LM Studio wymaga uwierzytelnienia, wpisz też **token API**. Tam też zmienisz język.
3. Zielona kropka przy polu wiadomości oznacza, że serwer naprawdę odpowiedział przez API i ma wybrany model. Żółta pulsuje w trakcie sprawdzania, a czerwona oznacza błąd (szczegóły w panelu ustawień). Kliknij nazwę modelu, by wybrać inny.
4. Napisz, co zrobić w projekcie, np. „przejrzyj projekt i opisz strukturę”.

## Ustawienia

| Ustawienie | Domyślnie | Opis |
|---|---|---|
| `syntaxcoder.host` | `127.0.0.1` | Adres serwera LM Studio |
| `syntaxcoder.port` | `1234` | Port serwera LM Studio |
| `syntaxcoder.https` | `false` | Połączenie przez https (np. reverse proxy); `https://` w polu hosta też to włącza |
| `syntaxcoder.apiKey` | `lm-studio` | Klucz API wysyłany, gdy nie zapisano tokenu API w panelu (trzymany otwartym tekstem w `settings.json`) |
| `syntaxcoder.model` | puste | Model; puste = pierwszy załadowany |
| `syntaxcoder.temperature` | `0.3` | Temperatura próbkowania |
| `syntaxcoder.maxTokens` | `4096` | Limit tokenów odpowiedzi |
| `syntaxcoder.autoApproveWrites` | `false` | Zapis plików bez pytania |
| `syntaxcoder.autoApproveTerminal` | `false` | Komendy bez pytania |
| `syntaxcoder.autonomousMode` | `false` | Wszystko bez pytania |
| `syntaxcoder.reviewer` | `false` | Recenzent sprawdza wykonanie zadania |
| `syntaxcoder.planMode` | `false` | Tryb planu: najpierw plan, zmiany dopiero po **Wykonaj plan** |
| `syntaxcoder.reasoning` | `""` | Poziom myślenia z suwaka **Myślenie** (np. `off`, `low`, `xhigh`, `on`); pusty albo spoza listy modelu = domyślny modelu |
| `syntaxcoder.inlineCompletions` | `false` | Inline suggestions: podpowiedzi kodu w edytorze (szary tekst, **Tab** przyjmuje) |
| `syntaxcoder.completionModel` | puste | Model do podpowiedzi; puste = model czatu |
| `syntaxcoder.webTools` | `false` | Przełącznik **Web**: narzędzia serwerów MCP dla agenta |
| `syntaxcoder.mcpServers` | context7, grep, deepwiki | Serwery MCP po HTTP: `"nazwa": { "type": "http", "url": "https://…" }` |
| `syntaxcoder.language` | `auto` | Język interfejsu: `auto` (jak VS Code), `en`, `de`, `fr`, `pl` |
| `syntaxcoder.commandTimeoutMs` | `60000` | Limit czasu jednej komendy (ms) |
| `syntaxcoder.maxTurns` | `100` | Rundy narzędzi na zadanie (5–1000); po ich wyczerpaniu agent kończy pracę podsumowaniem |

## Bezpieczeństwo

- Token API z panelu ustawień trafia do bezpiecznego magazynu VS Code (pęk kluczy systemu), a nie do `settings.json`. Rozszerzenie wysyła go tylko do serwera LM Studio jako `Authorization: Bearer` i nigdy nie pokazuje go w czacie.
- Agent działa tylko w otwartym folderze (workspace). Ścieżek spoza niego nie dotyka, także przez dowiązania symboliczne i junction.
- Rozszerzenie działa tylko w **zaufanych** folderach (Workspace Trust), bo może uruchamiać komendy.
- `autonomousMode`, `autoApproveWrites` i `autoApproveTerminal` wyłączają pytania o zgodę. Model może wtedy sam zmieniać pliki i uruchamiać dowolne komendy. Włączaj je tylko w projektach, którym ufasz.
- Te trzy ustawienia, ustawienia połączenia (`host`, `port`, `https`, `apiKey`, `model`, `completionModel`), `mcpServers`, `commandTimeoutMs`, `maxTurns` i wszystkie przełączniki z czatu (`reviewer`, `planMode`, `inlineCompletions`, `webTools`) działają tylko z ustawień użytkownika. `.vscode/settings.json` w repozytorium ich nie zmieni, więc nie przekieruje tokena ani kodu na obcy serwer i nie włączy po cichu wysyłania kodu.
- Przełącznik **Web** wysyła zapytania agenta do serwerów MCP w internecie, a zapytania mogą zawierać fragmenty kodu. Dlatego jego włączenie w czacie wymaga potwierdzenia ostrzeżenia. Wyniki z sieci trafiają do modelu jako dane z dopiskiem, że to nie są polecenia. Strona w sieci może jednak próbować sterować modelem (prompt injection). Z tego powodu nie łącz **Web** z trybem **Auto** w projektach, w których zależy Ci na bezpieczeństwie: bez **Auto** każdy zapis i każda komenda nadal czekają na Twoją zgodę.
- Zapis do `.git`, `.vscode`, `.devcontainer` i `.husky` zawsze wymaga zgody (poza trybem autonomicznym), bo hooki gita i zadania VS Code mogą uruchamiać kod.
- `read_file`, `grep` i podpowiedzi kodu nie czytają plików z sekretami (`.env`, `.env.local`, `.npmrc`, `.pypirc`, `.netrc`, `*.pem`, `*.key`). Pliki `.env.example` czyta normalnie.
- `delete_path` przenosi pliki do kosza systemowego, jeśli się da.
- Połączenie przez HTTP (np. LM Studio w sieci lokalnej) wysyła token i kod otwartym tekstem. Ktoś w tej samej sieci może je podejrzeć albo podmienić odpowiedzi modelu. Przy HTTP poza własnym komputerem nie włączaj trybu autonomicznego ani `autoApproveTerminal`.
- Wyjście komend agenta widać w panelu **Output → SyntaxCoder**.

## Języki

Czat, powiadomienia i komunikaty mają wersje: English, Deutsch, Français, Polski. Język wybierasz w panelu ustawień czatu (lista + **Zastosuj**, zmiana od razu) albo w `syntaxcoder.language`. Przy `auto` rozszerzenie bierze język VS Code (a gdy go nie obsługuje, angielski).

Nazwy komend i opisy ustawień VS Code zawsze pokazuje w swoim języku. Model dostaje polecenia po angielsku i odpowiada w języku, w którym do niego piszesz.

## Komendy palety

- `SyntaxCoder: Otwórz czat`
- `SyntaxCoder: Nowa rozmowa`
- `SyntaxCoder: Zatrzymaj`
- `SyntaxCoder: Wybierz model LM Studio`
- `SyntaxCoder: Ustawienia i połączenie`
- `SyntaxCoder: Dodaj zaznaczenie do czatu`

## Rozwój

```bash
npm install
npm run compile
```

`F5` w VS Code uruchamia rozszerzenie w oknie testowym. Paczkę `.vsix` budujesz przez `npm run package`, a publikujesz przez `npm run publish` (potrzebny token publishera z Azure DevOps).

## Licencja

[MIT](LICENSE) © Artur Pelo
