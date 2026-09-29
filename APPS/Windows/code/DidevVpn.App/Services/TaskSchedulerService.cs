using Microsoft.Win32.TaskScheduler;

namespace DidevVpn.App.Services;

/// <summary>
/// Registra la tarea de renovacion del usuario actual SIN elevar. Trampa
/// documentada en APPS/Windows/NOTAS-prompt-12-en-pausa.md punto 7:
/// "schtasks /sc ONLOGON" a secas falla sin elevar porque el trigger no
/// queda ligado a un usuario -aqui se evita poniendo <see cref="LogonTrigger.UserId"/>
/// explicitamente al usuario actual, con LogonType=InteractiveToken y
/// RunLevel=LUA (nunca "ejecutar con los privilegios mas altos": esta app no
/// los necesita ni debe pedirlos para renovar)-.
/// </summary>
internal sealed class TaskSchedulerService : ITaskSchedulerService
{
    private const string RenewalArgument = "--renew-silent";

    public void RegisterPerUserRenewalTask(string taskName, string executablePath)
    {
        using var taskService = new TaskService();
        var currentUser = Environment.UserDomainName is { Length: > 0 } domain
            ? $"{domain}\\{Environment.UserName}"
            : Environment.UserName;

        var definition = taskService.NewTask();
        definition.RegistrationInfo.Description = "Renueva el certificado de didev VPN si toca, aunque la app este cerrada.";
        definition.Principal.LogonType = TaskLogonType.InteractiveToken;
        definition.Principal.RunLevel = TaskRunLevel.LUA;
        definition.Principal.UserId = currentUser;
        definition.Settings.DisallowStartIfOnBatteries = false;
        definition.Settings.StopIfGoingOnBatteries = false;
        definition.Settings.ExecutionTimeLimit = TimeSpan.FromMinutes(5);

        definition.Triggers.Add(new LogonTrigger { UserId = currentUser });

        var timeTrigger = new TimeTrigger { StartBoundary = DateTime.Now };
        timeTrigger.Repetition.Interval = TimeSpan.FromHours(12);
        definition.Triggers.Add(timeTrigger);

        definition.Actions.Add(new ExecAction(executablePath, RenewalArgument, workingDirectory: null));

        taskService.RootFolder.RegisterTaskDefinition(taskName, definition);
    }

    public void RemovePerUserRenewalTask(string taskName)
    {
        using var taskService = new TaskService();
        taskService.RootFolder.DeleteTask(taskName, exceptionOnNotExists: false);
    }

    public bool PerUserRenewalTaskExists(string taskName)
    {
        using var taskService = new TaskService();
        return taskService.GetTask(taskName) is not null;
    }

    public string? GetRegisteredExecutablePath(string taskName)
    {
        using var taskService = new TaskService();
        var task = taskService.GetTask(taskName);
        return task?.Definition.Actions.OfType<ExecAction>().FirstOrDefault()?.Path;
    }
}
