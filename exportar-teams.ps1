# Exporta as conversas de chat do Teams (1:1, grupo, reuniao) dos ultimos N dias
# para um markdown legivel, usando o Microsoft Graph com permissao delegada Chat.Read.
# Uso: powershell -ExecutionPolicy Bypass -File exportar-teams.ps1 [-Dias 14]
param(
    [int]$Dias = 14,
    [string]$Saida = (Join-Path $PSScriptRoot 'export'),
    [switch]$CodigoDispositivo
)

$ErrorActionPreference = 'Stop'
Import-Module Microsoft.Graph.Authentication

$conexao = @{ Scopes = @('Chat.Read', 'User.Read'); NoWelcome = $true }
if ($CodigoDispositivo) { $conexao.UseDeviceCode = $true }
Connect-MgGraph @conexao

$fuso = [TimeZoneInfo]::FindSystemTimeZoneById('E. South America Standard Time')
$corte = (Get-Date).ToUniversalTime().AddDays(-$Dias)

function Para-Utc($v) {
    if ($null -eq $v) { return $null }
    if ($v -is [datetime]) { return $v.ToUniversalTime() }
    return [datetime]::Parse($v, [Globalization.CultureInfo]::InvariantCulture,
        [Globalization.DateTimeStyles]::AdjustToUniversal -bor [Globalization.DateTimeStyles]::AssumeUniversal)
}

function Para-Brt($utc) { [TimeZoneInfo]::ConvertTimeFromUtc($utc, $fuso).ToString('dd/MM HH:mm') }

function Chamar($uri) {
    for ($t = 1; $t -le 5; $t++) {
        try { return Invoke-MgGraphRequest -Method GET -Uri $uri }
        catch {
            $cod = $_.Exception.Response.StatusCode.value__
            if ($cod -eq 429 -or $cod -ge 500) { Start-Sleep -Seconds (5 * $t) } else { throw }
        }
    }
    throw "Falhou apos 5 tentativas: $uri"
}

function Texto-Limpo($html) {
    if (-not $html) { return '' }
    $t = $html -replace '(?i)<br\s*/?>|</p>|</div>', "`n"
    $t = $t -replace '<[^>]+>', ''
    $t = [System.Net.WebUtility]::HtmlDecode($t)
    return (($t -split "`n" | ForEach-Object { $_.Trim() } | Where-Object { $_ }) -join "`n")
}

$eu = Chamar 'https://graph.microsoft.com/v1.0/me?$select=id,displayName'

# Chats ordenados pela ultima mensagem; para quando passa do corte
$chats = @()
$uri = 'https://graph.microsoft.com/v1.0/me/chats?$expand=lastMessagePreview&$orderby=lastMessagePreview/createdDateTime desc&$top=50'
:pag while ($uri) {
    $r = Chamar $uri
    foreach ($c in $r.value) {
        $ult = Para-Utc $c.lastMessagePreview.createdDateTime
        if ($null -eq $ult) { continue }
        if ($ult -lt $corte) { break pag }
        $chats += $c
    }
    $uri = $r.'@odata.nextLink'
}

$linhas = New-Object System.Collections.Generic.List[string]
$linhas.Add("# Conversas do Teams - ultimos $Dias dias")
$linhas.Add("Exportado em $(Para-Brt (Get-Date).ToUniversalTime()) (Brasilia) para $($eu.displayName). Total de chats: $($chats.Count).")
$linhas.Add('')

$n = 0
foreach ($c in $chats) {
    $n++
    Write-Progress -Activity 'Lendo chats' -Status "$n de $($chats.Count)" -PercentComplete (100 * $n / $chats.Count)

    $membros = (Chamar "https://graph.microsoft.com/v1.0/chats/$($c.id)/members").value |
        Where-Object { $_.userId -ne $eu.id } | ForEach-Object { $_.displayName }
    $nome = if ($c.topic) { $c.topic } else { ($membros -join ', ') }
    if (-not $nome) { $nome = '(sem nome)' }

    $msgs = @()
    $uri = "https://graph.microsoft.com/v1.0/chats/$($c.id)/messages?`$top=50&`$orderby=createdDateTime desc"
    :msg while ($uri) {
        $r = Chamar $uri
        foreach ($m in $r.value) {
            $quando = Para-Utc $m.createdDateTime
            if ($quando -lt $corte) { break msg }
            if ($m.messageType -ne 'message' -or $m.deletedDateTime) { continue }
            $msgs += [pscustomobject]@{ Quando = $quando; De = $m.from.user.displayName; Id = $m.from.user.id; Texto = Texto-Limpo $m.body.content }
        }
        $uri = $r.'@odata.nextLink'
    }
    if (-not $msgs) { continue }

    $linhas.Add("## [$($c.chatType)] $nome")
    $linhas.Add("Participantes: $($membros -join ', ')")
    $linhas.Add('')
    foreach ($m in ($msgs | Sort-Object Quando)) {
        $autor = if ($m.Id -eq $eu.id) { 'EU' } elseif ($m.De) { $m.De } else { '(app/bot)' }
        $txt = if ($m.Texto) { $m.Texto -replace "`n", "`n    " } else { '(anexo/imagem/reacao)' }
        $linhas.Add("- $(Para-Brt $m.Quando) **$autor**: $txt")
    }
    $linhas.Add('')
}

New-Item -ItemType Directory -Force $Saida | Out-Null
$arquivo = Join-Path $Saida ("teams_{0}.md" -f (Get-Date -Format 'yyyy-MM-dd_HHmm'))
[IO.File]::WriteAllLines($arquivo, $linhas, (New-Object Text.UTF8Encoding($true)))
Write-Host "OK: $arquivo ($($chats.Count) chats)"
