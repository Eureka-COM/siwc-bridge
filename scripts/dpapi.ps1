param([Parameter(Mandatory=$true)][string]$PipeName,[Parameter(Mandatory=$true)][ValidateSet('protect','unprotect','secure-directory','secure-file','lock')][string]$Mode)
$ErrorActionPreference = 'Stop'
$pipe = $null
$lock = $null
try {
    Add-Type -AssemblyName System.Security
    $sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
    $security = New-Object System.IO.Pipes.PipeSecurity
    $security.SetAccessRuleProtection($true, $false)
    $security.SetOwner($sid)
    $rule = New-Object System.IO.Pipes.PipeAccessRule($sid, [System.IO.Pipes.PipeAccessRights]::FullControl, [System.Security.AccessControl.AccessControlType]::Allow)
    $security.AddAccessRule($rule)
    $pipe = New-Object System.IO.Pipes.NamedPipeServerStream($PipeName, [System.IO.Pipes.PipeDirection]::InOut, 1, [System.IO.Pipes.PipeTransmissionMode]::Byte, [System.IO.Pipes.PipeOptions]::Asynchronous, 4096, 4096, $security)
    [Console]::Out.WriteLine('ready')
    $pipe.WaitForConnection()
    $reader = New-Object System.IO.StreamReader($pipe, [System.Text.Encoding]::UTF8, $false, 4096, $true)
    $writer = New-Object System.IO.StreamWriter($pipe, (New-Object System.Text.UTF8Encoding($false)), 4096, $true)
    $writer.AutoFlush = $true
    $value = $reader.ReadLine()
    switch ($Mode) {
        'protect' {
            $inputBytes = [Convert]::FromBase64String($value)
            $outputBytes = [System.Security.Cryptography.ProtectedData]::Protect($inputBytes, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser)
            $writer.WriteLine([Convert]::ToBase64String($outputBytes))
            [Array]::Clear($inputBytes, 0, $inputBytes.Length)
        }
        'unprotect' {
            $inputBytes = [Convert]::FromBase64String($value)
            $outputBytes = [System.Security.Cryptography.ProtectedData]::Unprotect($inputBytes, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser)
            $writer.WriteLine([Convert]::ToBase64String($outputBytes))
            [Array]::Clear($outputBytes, 0, $outputBytes.Length)
        }
        'secure-directory' {
            $path = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($value))
            $acl = New-Object System.Security.AccessControl.DirectorySecurity
            $acl.SetAccessRuleProtection($true, $false)
            $acl.SetOwner($sid)
            $access = New-Object System.Security.AccessControl.FileSystemAccessRule($sid, [System.Security.AccessControl.FileSystemRights]::FullControl, ([System.Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [System.Security.AccessControl.InheritanceFlags]::ObjectInherit), [System.Security.AccessControl.PropagationFlags]::None, [System.Security.AccessControl.AccessControlType]::Allow)
            $acl.AddAccessRule($access)
            [System.IO.Directory]::SetAccessControl($path, $acl)
            $writer.WriteLine('ok')
        }
        'secure-file' {
            $path = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($value))
            $acl = New-Object System.Security.AccessControl.FileSecurity
            $acl.SetAccessRuleProtection($true, $false)
            $acl.SetOwner($sid)
            $access = New-Object System.Security.AccessControl.FileSystemAccessRule($sid, [System.Security.AccessControl.FileSystemRights]::FullControl, [System.Security.AccessControl.AccessControlType]::Allow)
            $acl.AddAccessRule($access)
            [System.IO.File]::SetAccessControl($path, $acl)
            $writer.WriteLine('ok')
        }
        'lock' {
            $path = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($value))
            try { $lock = New-Object System.IO.FileStream($path, [System.IO.FileMode]::OpenOrCreate, [System.IO.FileAccess]::ReadWrite, [System.IO.FileShare]::None) }
            catch [System.IO.IOException] { $writer.WriteLine('busy'); exit 0 }
            $writer.WriteLine('locked')
            [void]$reader.ReadLine()
        }
    }
} catch {
    # Never write exception details, input, tokens, or paths to stdout/stderr.
    exit 1
} finally {
    if ($null -ne $lock) { $lock.Dispose() }
    if ($null -ne $pipe) { $pipe.Dispose() }
}
